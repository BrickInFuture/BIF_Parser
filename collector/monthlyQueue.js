/**
 * Месячная очередь «кого снимать» — чтобы НЕ обходить весь каталог каждый залп.
 *
 * Идея (канон BIF_parser.md § «Бюджет Firestore»):
 *   • Один раз в начале месяца (или при первом залпе) читаем каталог ОДИН раз,
 *     раскладываем id по приоритету и сохраняем список в Firestore чанками.
 *   • Каждый залп только берёт следующий кусок списка по курсору (2–3 чтения),
 *     а не листает 20–25 тысяч карточек заново. Это и жгло деньги.
 *   • Ошибки живут отдельно (status=error в market_observations) и их отдельно
 *     проходит ingestRetryErrors (в течение месяца и на конце). Здесь — только
 *     план обхода «текущий месяц».
 *
 * Хранение:
 *   price_ingest_queue/{queueId}                 — мета { periodId, total, chunkSize,
 *                                                  chunkCount, offset, pass, builtAt }
 *   price_ingest_queue/{queueId}/chunks/{index}  — { index, ids: [...] }
 *
 * Список — простой массив id по приоритету. Статус «сделан» НЕ храним по каждому
 * (это лишние записи): курсор просто идёт вперёд, а дорогой каталог не трогаем.
 * Проверку «уже с ценой?» делает сам залп по каждому взятому id (1 дешёвое чтение),
 * поэтому уже снятые (например, кнопкой «обновить цену») просто пропускаются.
 */
"use strict";

const { scoreCatalogPriority, catalogReleaseYear } = require("./catalogPriority");
const { PRIMARY_TYPES, typePriorityRank } = require("./ingestTypes");

const QUEUE_COLLECTION = "price_ingest_queue";
const DEFAULT_CHUNK_SIZE = 5000;

function queueIdFor(periodId, shardIndex = 0, shardCount = 1) {
  const base = `bricklink_${periodId}`;
  return shardCount > 1 ? `${base}_s${shardIndex}` : base;
}

function queueMetaRef(db, queueId) {
  return db.collection(QUEUE_COLLECTION).doc(queueId);
}

function queueChunkRef(db, queueId, index) {
  return db.collection(QUEUE_COLLECTION).doc(queueId).collection("chunks").doc(String(index));
}

/**
 * Чистая сортировка каталожных объектов в порядок обхода:
 *   тип (SET → MINIFIG → GEAR) → приоритет (новинки/год/тема) → год убыв. → id.
 * @param {Array<{catalogItemId:string,itemType?:string}>} cats
 * @returns {string[]} ids
 */
function orderCatalogForQueue(cats) {
  const rows = (cats || []).filter((c) => c && c.catalogItemId);
  rows.sort((a, b) => {
    const ta = typePriorityRank(a.itemType);
    const tb = typePriorityRank(b.itemType);
    if (ta !== tb) return ta - tb;
    const sa = scoreCatalogPriority(a, { skip: false });
    const sb = scoreCatalogPriority(b, { skip: false });
    if (sb !== sa) return sb - sa;
    const yb = catalogReleaseYear(b);
    const ya = catalogReleaseYear(a);
    if (yb !== ya) return yb - ya;
    return String(a.catalogItemId).localeCompare(String(b.catalogItemId));
  });
  return rows.map((c) => c.catalogItemId);
}

/** Разложить id по чанкам фикс. размера. */
function chunkIds(ids, chunkSize = DEFAULT_CHUNK_SIZE) {
  const size = Math.max(1, Math.floor(Number(chunkSize) || DEFAULT_CHUNK_SIZE));
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Чистое планирование чтения: с какого места (offset) какие чанки прочитать,
 * чтобы набрать `want` id. Возвращает диапазоны и новый offset.
 * @returns {{ ranges: Array<{chunk:number,start:number,end:number}>, count:number, nextOffset:number, exhausted:boolean }}
 */
function planRead(offset, want, chunkSize, total) {
  const size = Math.max(1, Math.floor(Number(chunkSize) || DEFAULT_CHUNK_SIZE));
  const tot = Math.max(0, Math.floor(Number(total) || 0));
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const need = Math.max(0, Math.floor(Number(want) || 0));
  if (from >= tot || need === 0) {
    return { ranges: [], count: 0, nextOffset: from, exhausted: from >= tot };
  }
  const to = Math.min(tot, from + need);
  const ranges = [];
  let pos = from;
  while (pos < to) {
    const chunk = Math.floor(pos / size);
    const start = pos % size;
    const chunkEndGlobal = (chunk + 1) * size;
    const end = Math.min(to, chunkEndGlobal) - chunk * size; // offset within chunk
    ranges.push({ chunk, start, end });
    pos = chunk * size + end;
  }
  return { ranges, count: to - from, nextOffset: to, exhausted: to >= tot };
}

async function readQueueMeta(db, queueId) {
  const snap = await queueMetaRef(db, queueId).get();
  return snap.exists ? snap.data() || null : null;
}

/**
 * Построить месячную очередь одним обходом каталога.
 * @param {FirebaseFirestore.Firestore} db
 * @param {*} admin
 * @param {{ periodId:string, types?:string[], shardIndex?:number, shardCount?:number,
 *   chunkSize?:number, mapCatalogDoc:(doc:any)=>any, keep?:(cat:any)=>Promise<boolean>|boolean,
 *   FieldValue:any, pass?:number }} opts
 */
async function buildMonthlyQueue(db, admin, opts) {
  const periodId = String(opts.periodId);
  const types = (opts.types || PRIMARY_TYPES).map((t) => String(t).toUpperCase());
  const shardIndex = Number(opts.shardIndex) || 0;
  const shardCount = Math.max(1, Number(opts.shardCount) || 1);
  const chunkSize = Math.max(1, Math.floor(Number(opts.chunkSize) || DEFAULT_CHUNK_SIZE));
  const mapCatalogDoc = opts.mapCatalogDoc;
  const keep = opts.keep || null;
  const FieldValue = opts.FieldValue;
  const queueId = queueIdFor(periodId, shardIndex, shardCount);

  function shardOk(id) {
    if (shardCount <= 1) return true;
    const s = String(id || "");
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % shardCount === shardIndex;
  }

  const cats = [];
  for (const itemType of types) {
    let lastId = null;
    for (;;) {
      let q = db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(500);
      if (lastId) q = q.startAfter(lastId);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        if (!shardOk(doc.id)) continue;
        const cat = mapCatalogDoc(doc);
        if (!cat.itemNumber || !cat.supportedBlType || cat.mistypedGear) continue;
        if (keep) {
          // eslint-disable-next-line no-await-in-loop
          const ok = await keep(cat);
          if (!ok) continue;
        }
        cats.push(cat);
      }
      lastId = snap.docs[snap.docs.length - 1].id;
      if (snap.size < 500) break;
    }
  }

  const ids = orderCatalogForQueue(cats);
  const chunks = chunkIds(ids, chunkSize);

  // Записать чанки, затем мету (мета последней — чтобы читатель не увидел частичную).
  for (let i = 0; i < chunks.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await queueChunkRef(db, queueId, i).set({ index: i, ids: chunks[i] }, { merge: false });
  }
  await queueMetaRef(db, queueId).set(
    {
      periodId,
      total: ids.length,
      chunkSize,
      chunkCount: chunks.length,
      offset: 0,
      pass: Math.max(0, Number(opts.pass) || 0),
      shardIndex,
      shardCount,
      filtered: !!keep,
      builtAt: FieldValue ? FieldValue.serverTimestamp() : new Date(),
    },
    { merge: false }
  );

  return { queueId, total: ids.length, chunkCount: chunks.length };
}

/**
 * Взять следующие `want` id из очереди и сдвинуть курсор.
 * @returns {{ ids:string[], exhausted:boolean, meta:object|null, offset:number, total:number }}
 */
async function popQueueIds(db, queueId, want, opts = {}) {
  const FieldValue = opts.FieldValue;
  const meta = await readQueueMeta(db, queueId);
  if (!meta) return { ids: [], exhausted: true, meta: null, offset: 0, total: 0 };
  const chunkSize = Math.max(1, Number(meta.chunkSize) || DEFAULT_CHUNK_SIZE);
  const total = Math.max(0, Number(meta.total) || 0);
  const offset = Math.max(0, Number(meta.offset) || 0);
  const plan = planRead(offset, want, chunkSize, total);
  if (!plan.ranges.length) {
    return { ids: [], exhausted: plan.exhausted, meta, offset, total };
  }

  const ids = [];
  const chunkCache = new Map();
  for (const r of plan.ranges) {
    let arr = chunkCache.get(r.chunk);
    if (!arr) {
      // eslint-disable-next-line no-await-in-loop
      const cSnap = await queueChunkRef(db, queueId, r.chunk).get();
      arr = (cSnap.exists && Array.isArray(cSnap.data().ids)) ? cSnap.data().ids : [];
      chunkCache.set(r.chunk, arr);
    }
    for (let i = r.start; i < r.end && i < arr.length; i += 1) ids.push(arr[i]);
  }

  if (!opts.dryRun) {
    await queueMetaRef(db, queueId).set(
      {
        offset: plan.nextOffset,
        updatedAt: FieldValue ? FieldValue.serverTimestamp() : new Date(),
      },
      { merge: true }
    );
  }

  return { ids, exhausted: plan.exhausted, meta, offset: plan.nextOffset, total };
}

/** Сбросить курсор на начало (новый круг обхода в пределах месяца). */
async function wrapQueue(db, queueId, opts = {}) {
  const FieldValue = opts.FieldValue;
  const meta = await readQueueMeta(db, queueId);
  const pass = (Number(meta && meta.pass) || 0) + 1;
  await queueMetaRef(db, queueId).set(
    {
      offset: 0,
      pass,
      wrappedAt: FieldValue ? FieldValue.serverTimestamp() : new Date(),
    },
    { merge: true }
  );
  return { pass };
}

module.exports = {
  QUEUE_COLLECTION,
  DEFAULT_CHUNK_SIZE,
  queueIdFor,
  queueMetaRef,
  queueChunkRef,
  orderCatalogForQueue,
  chunkIds,
  planRead,
  readQueueMeta,
  buildMonthlyQueue,
  popQueueIds,
  wrapQueue,
};
