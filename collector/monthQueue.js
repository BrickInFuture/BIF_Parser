/**
 * Месячная очередь съёма: один полный обход каталога → список id,
 * залпы только берут следующий кусок (без повторного скана базы).
 *
 * Документы:
 *   price_ingest_queues/market_{YYYY-MM}              — мета + курсор
 *   price_ingest_queues/market_{YYYY-MM}/chunks/{n}   — пачки id
 *   price_ingest_queues/market_{YYYY-MM}/errors/{id}  — ошибки с retryAfterMs
 *
 * Канон: BIF_parser.md § Бюджет Firestore / месячная очередь.
 */
"use strict";

const { observationDocId } = require("./catalogFields");
const { utcYearMonth } = require("./gapLedger");
const { scoreCatalogPriority, catalogReleaseYear } = require("./catalogPriority");
const { classifyCoverage } = require("./coveragePolicy");
const { PRIMARY_TYPES, typePriorityRank } = require("./ingestTypes");
const { errorLooksLikeSoftBlock } = require("./parseHtml");

const QUEUE_COLL = "price_ingest_queues";
const CHUNK_SIZE = Math.max(100, Number(process.env.BL_MONTH_QUEUE_CHUNK) || 500);

function queueDocId(periodId, source = "bricklink") {
  // Тот же префикс, что у price_ingest_runs/bricklink_{period} — один стиль id.
  return `${source}_${periodId}`;
}

function queueRef(db, periodId, source = "bricklink") {
  return db.collection(QUEUE_COLL).doc(queueDocId(periodId, source));
}

function chunkId(n) {
  return String(Math.max(0, Number(n) || 0)).padStart(4, "0");
}

function softRetryMs(errorTag, error) {
  if (errorLooksLikeSoftBlock(errorTag, error)) {
    // IP остывает за ~1ч; берём 2–3ч с запасом, не ждём 26-го.
    return 2.5 * 60 * 60 * 1000;
  }
  const tag = String(errorTag || "").toLowerCase();
  if (tag.includes("parse") || tag === "partial_prices") return 45 * 60 * 1000;
  if (tag.includes("timeout") || tag.includes("net")) return 60 * 60 * 1000;
  return 90 * 60 * 1000;
}

/**
 * Нужен ли съём monthly-точки (1 чтение).
 * @param {string} [source] market | brickowl
 * @param {string} [monthDocId] id monthly-дока (по умолчанию periodId очереди)
 */
async function needsCurrentMonth(db, catalogItemId, periodId, source = "bricklink", monthDocId = null) {
  const src = String(source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  const monthId = monthDocId || periodId;
  const obsId = observationDocId(catalogItemId, src);
  const snap = await db
    .collection("market_observations")
    .doc(obsId)
    .collection("monthly")
    .doc(monthId)
    .get();
  if (!snap.exists) return true;
  const d = snap.data() || {};
  const st = String(d.status || "");
  if (st === "error" || st === "fail") return true;
  if (st === "ok" || st === "no_data") return false;
  return true;
}

/**
 * Собрать и записать очередь на месяц (дорого — только раз / по --rebuild).
 * @returns {Promise<{ total: number, chunkCount: number, scanned: number }>}
 */
async function buildMonthQueue(db, admin, opts = {}) {
  const FieldValue = opts.FieldValue || admin.firestore.FieldValue;
  const periodId = opts.periodId || utcYearMonth();
  const source =
    String(opts.source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  /** Для Owl пишем lastClosed-месяц — проверка дыры по этому id. */
  const checkMonthId = opts.checkMonthId || periodId;
  const types = (opts.types || PRIMARY_TYPES).map((t) => String(t).toUpperCase());
  const mapCatalogDoc = opts.mapCatalogDoc;
  if (typeof mapCatalogDoc !== "function") {
    throw new Error("buildMonthQueue: mapCatalogDoc required");
  }
  const dryRun = opts.dryRun === true;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const ref = queueRef(db, periodId, source);

  if (!dryRun) {
    await ref.set(
      {
        periodId,
        source,
        checkMonthId,
        status: "building",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  const scored = [];
  let scanned = 0;
  let needReads = 0;

  for (const itemType of types) {
    let lastId = null;
    for (;;) {
      let q = db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(200);
      if (lastId) q = q.startAfter(lastId);
      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        scanned += 1;
        const cat = mapCatalogDoc(doc);
        if (!cat.itemNumber) continue;
        if (source === "bricklink" && (!cat.supportedBlType || cat.mistypedGear)) continue;
        const classif = classifyCoverage(cat, nowMs);
        if (classif.cohort === "too_early") continue;

        needReads += 1;
        const needs = await needsCurrentMonth(db, doc.id, periodId, source, checkMonthId);
        if (!needs) continue;

        const coverage = { skip: false, reason: "month_queue_need", cohort: classif.cohort };
        let score = scoreCatalogPriority(cat, coverage);
        score += 5000; // все здесь — «нужен текущий месяц»
        score += typePriorityRank(cat.itemType) * -10;
        score += catalogReleaseYear(cat);
        scored.push({ id: doc.id, score, itemType: cat.itemType });
      }

      lastId = snap.docs[snap.docs.length - 1].id;
      if (snap.size < 200) break;
    }
  }

  scored.sort((a, b) => {
    const ta = typePriorityRank(a.itemType);
    const tb = typePriorityRank(b.itemType);
    if (ta !== tb) return ta - tb;
    if (b.score !== a.score) return b.score - a.score;
    return String(a.id).localeCompare(String(b.id));
  });
  const ids = scored.map((x) => x.id);

  if (dryRun) {
    return { total: ids.length, chunkCount: Math.ceil(ids.length / CHUNK_SIZE), scanned, needReads, dryRun: true };
  }

  // Снести старые chunks/errors перед записью.
  const oldChunks = await ref.collection("chunks").listDocuments();
  for (let i = 0; i < oldChunks.length; i += 400) {
    const batch = db.batch();
    for (const d of oldChunks.slice(i, i + 400)) batch.delete(d);
    await batch.commit();
  }

  const chunkCount = Math.ceil(ids.length / CHUNK_SIZE) || 0;
  for (let c = 0; c < chunkCount; c += 1) {
    const slice = ids.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
    await ref.collection("chunks").doc(chunkId(c)).set({ ids: slice, n: slice.length });
  }

  await ref.set(
    {
      periodId,
      source,
      checkMonthId,
      status: "ready",
      total: ids.length,
      remaining: ids.length,
      done: 0,
      chunkCount,
      chunkSize: CHUNK_SIZE,
      cursorChunk: 0,
      cursorIndex: 0,
      scanned,
      needReads,
      builtAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastRebuildUtcDay: new Date(nowMs).toISOString().slice(0, 10),
    },
    { merge: true }
  );

  console.log(
    JSON.stringify({
      step: "month_queue_built",
      periodId,
      source,
      total: ids.length,
      chunkCount,
      scanned,
      needReads,
    })
  );

  return { total: ids.length, chunkCount, scanned, needReads, source };
}

/**
 * Есть ли готовая очередь на месяц.
 */
async function readMonthQueueMeta(db, periodId, source = "bricklink") {
  const snap = await queueRef(db, periodId, source).get();
  if (!snap.exists) return null;
  return { id: snap.id, ref: snap.ref, ...(snap.data() || {}) };
}

/**
 * Собрать очередь, если нет / статус не ready / --rebuild.
 */
async function ensureMonthQueue(db, admin, opts = {}) {
  const periodId = opts.periodId || utcYearMonth();
  const source =
    String(opts.source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  const force = opts.rebuild === true;
  const meta = await readMonthQueueMeta(db, periodId, source);
  if (!force && meta && String(meta.status) === "ready" && Number(meta.chunkCount) >= 0) {
    return { built: false, meta };
  }
  // Другой процесс уже собирает (локальный build / параллельный залп) — ждём ready,
  // не стартуем второй полный обход каталога (дорого и ломает чанки).
  if (!force && meta && String(meta.status) === "building") {
    const waitMs = Math.max(30_000, Number(opts.buildWaitMs) || 20 * 60 * 1000);
    const step = 15_000;
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      await new Promise((r) => setTimeout(r, step));
      const again = await readMonthQueueMeta(db, periodId, source);
      if (again && String(again.status) === "ready") {
        console.log(
          JSON.stringify({
            step: "month_queue_wait_ready",
            source,
            waitedSec: Math.round((Date.now() - started) / 1000),
            total: again.total,
          })
        );
        return { built: false, meta: again, waited: true };
      }
      if (!again || String(again.status) !== "building") break;
    }
  }
  const r = await buildMonthQueue(db, admin, { ...opts, source });
  const fresh = await readMonthQueueMeta(db, periodId, source);
  return { built: true, meta: fresh, build: r };
}

/**
 * Взять следующие N id из месячной очереди (двигает курсор).
 * Дешёво: 1–2 чтения chunks + 1 запись меты.
 */
async function takeFromMonthQueue(db, admin, opts = {}) {
  const FieldValue = opts.FieldValue || admin.firestore.FieldValue;
  const periodId = opts.periodId || utcYearMonth();
  const source =
    String(opts.source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  const limit = Math.max(1, Number(opts.limit) || 50);
  const dryRun = opts.dryRun === true;
  const ref = queueRef(db, periodId, source);

  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(ref);
    if (!metaSnap.exists) return { ids: [], exhausted: true, remaining: 0 };
    const meta = metaSnap.data() || {};
    if (String(meta.status) !== "ready") return { ids: [], exhausted: true, remaining: 0 };

    let chunk = Number(meta.cursorChunk) || 0;
    let index = Number(meta.cursorIndex) || 0;
    const chunkCount = Number(meta.chunkCount) || 0;
    const out = [];

    while (out.length < limit && chunk < chunkCount) {
      const cRef = ref.collection("chunks").doc(chunkId(chunk));
      const cSnap = await tx.get(cRef);
      const ids = cSnap.exists ? (cSnap.data() || {}).ids || [] : [];
      if (!ids.length || index >= ids.length) {
        chunk += 1;
        index = 0;
        continue;
      }
      while (out.length < limit && index < ids.length) {
        out.push(ids[index]);
        index += 1;
      }
      if (index >= ids.length) {
        chunk += 1;
        index = 0;
      }
    }

    const taken = out.length;
    const prevRemaining = Number(meta.remaining);
    const remaining = Number.isFinite(prevRemaining)
      ? Math.max(0, prevRemaining - taken)
      : Math.max(0, (Number(meta.total) || 0) - (Number(meta.done) || 0) - taken);

    if (!dryRun) {
      tx.set(
        ref,
        {
          cursorChunk: chunk,
          cursorIndex: index,
          remaining,
          done: (Number(meta.done) || 0) + taken,
          updatedAt: FieldValue.serverTimestamp(),
          lastTakeAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return {
      ids: out,
      exhausted: chunk >= chunkCount && out.length === 0,
      remaining,
      taken,
    };
  });
}

/**
 * Ошибка съёма → в очередь повтора (не теряем после take).
 * По умолчанию retryAfterMs далеко в хвост месяца (не каждый залп).
 */
async function pushMonthQueueError(db, admin, opts = {}) {
  const FieldValue = opts.FieldValue || admin.firestore.FieldValue;
  const periodId = opts.periodId || utcYearMonth();
  const source =
    String(opts.source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  const catalogItemId = String(opts.catalogItemId || "");
  if (!catalogItemId) return null;
  const errorTag = opts.errorTag || null;
  const error = opts.error || null;
  // Хвост месяца: ошибки не мешаем в обычные залпы (retryAfter далеко),
  // пока BL_ERROR_RETRY_IMMEDIATE=1 не включит старый короткий cool.
  let cool;
  if (process.env.BL_ERROR_RETRY_IMMEDIATE === "1" || opts.immediate === true) {
    cool = softRetryMs(errorTag, error);
  } else {
    // ~до 26-го числа UTC текущего месяца + небольшой запас.
    const now = new Date();
    const tail = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 26, 12, 0, 0);
    cool = Math.max(12 * 60 * 60 * 1000, tail - Date.now());
  }
  const retryAfterMs = Date.now() + cool;
  const ref = queueRef(db, periodId, source).collection("errors").doc(catalogItemId);
  await ref.set(
    {
      catalogItemId,
      errorTag,
      error: error ? String(error).slice(0, 240) : null,
      retryAfterMs,
      updatedAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    },
    { merge: true }
  );
  return { catalogItemId, retryAfterMs, coolMs: cool };
}

/**
 * Забрать ошибки, у которых подошло время повтора.
 */
async function takeDueMonthQueueErrors(db, admin, opts = {}) {
  const FieldValue = opts.FieldValue || admin.firestore.FieldValue;
  const periodId = opts.periodId || utcYearMonth();
  const source =
    String(opts.source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  const limit = Math.max(1, Number(opts.limit) || 10);
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const dryRun = opts.dryRun === true;
  const col = queueRef(db, periodId, source).collection("errors");

  // Без составного индекса: берём пачку, фильтруем в памяти.
  const snap = await col.orderBy("retryAfterMs", "asc").limit(Math.max(limit * 3, 30)).get();
  const due = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (Number(d.retryAfterMs) > nowMs) continue;
    due.push(doc.id);
    if (due.length >= limit) break;
  }

  if (!dryRun) {
    for (const id of due) {
      await col.doc(id).delete();
    }
  }

  if (due.length) {
    console.log(
      JSON.stringify({ step: "month_queue_errors_due", source, count: due.length, periodId })
    );
  }
  return { ids: due };
}

/**
 * Успех → убрать из ошибок (если был).
 */
async function clearMonthQueueError(db, periodId, catalogItemId, source = "bricklink") {
  if (!catalogItemId) return;
  try {
    await queueRef(db, periodId, source).collection("errors").doc(String(catalogItemId)).delete();
  } catch {
    //
  }
}

/**
 * Загрузить карточки каталога по списку id (N чтений, не обход).
 */
async function loadCatalogDocsByIds(db, ids, mapCatalogDoc, opts = {}) {
  const source =
    String(opts.source || "bricklink").toLowerCase() === "brickowl" ? "brickowl" : "bricklink";
  const out = [];
  const list = (ids || []).filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const slice = list.slice(i, i + 100);
    const refs = slice.map((id) => db.collection("catalog_items").doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const cat = mapCatalogDoc(snap);
      if (!cat.itemNumber) continue;
      if (source === "bricklink" && (!cat.supportedBlType || cat.mistypedGear)) continue;
      out.push(cat);
    }
  }
  return out;
}

module.exports = {
  QUEUE_COLL,
  CHUNK_SIZE,
  queueDocId,
  queueRef,
  buildMonthQueue,
  ensureMonthQueue,
  readMonthQueueMeta,
  takeFromMonthQueue,
  pushMonthQueueError,
  takeDueMonthQueueErrors,
  clearMonthQueueError,
  loadCatalogDocsByIds,
  needsCurrentMonth,
  softRetryMs,
};
