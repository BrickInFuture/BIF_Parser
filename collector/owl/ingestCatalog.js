/**
 * Залп Brick Owl из месячной очереди — та же схема, что у основного источника:
 * пинок каждые 30 мин, параллельные потоки, очередь кусками, повторы ошибок в обычных залпах.
 *
 *   npm run ingest:brickowl:catalog -- --confirm --limit=200 --maxMinutes=25
 *
 * Канон: BIF_parser.md.
 */
"use strict";

const { initFirebaseAdmin } = require("../firebaseAdmin");
const { observationDocId } = require("../catalogFields");
const { lastClosedUtcYearMonth, utcYearMonth } = require("../gapLedger");
const {
  ensureMonthQueue,
  takeFromMonthQueue,
  takeDueMonthQueueErrors,
  pushMonthQueueError,
  clearMonthQueueError,
  loadCatalogDocsByIds,
  readMonthQueueMeta,
} = require("../monthQueue");
const {
  bumpParserStats,
  createStatsAccumulator,
  trackMonthAnswer,
} = require("../parserStats");
const { setNoFromCatalogItemId } = require("./boUrls");
const {
  fetchBrickOwlPriceHistory,
  isOwlPermanentMiss,
  isOwlSoftBlock,
} = require("./fetchPriceHistory");
const { writeRawBrickOwlSixMonthAsLastClosed, writeRawBrickOwlError } = require("./writeRawObservation");
const { writeIngestArtifact } = require("../ingestReportArtifacts");
const { PRIMARY_TYPES } = require("./gapQueue");
const { markOwlCollectorHot } = require("./collectorGate");
const { normalizeSetNo } = require("../parseHtml");
const {
  proxyEnvUrl,
  setProxyUrlOverride,
  startPortInOwnRange,
  withRandomProxyPort,
} = require("../httpProxy");

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parsePauseMs() {
  const raw = String(process.env.BO_PAUSE_MS || flagValue("pauseMs", "6000,12000"));
  const parts = raw.split(",").map((s) => Number(String(s).trim()));
  const a = Number.isFinite(parts[0]) ? Math.max(0, parts[0]) : 6000;
  const b = Number.isFinite(parts[1]) ? Math.max(a, parts[1]) : Math.max(a, 12000);
  return [a, b];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randPause([lo, hi]) {
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function mapCatalogDocLite(doc) {
  const d = doc.data() || {};
  const itemType = String(d.itemType || "SET").toUpperCase();
  return {
    catalogItemId: doc.id,
    itemType,
    itemNumber:
      normalizeSetNo(d.itemNumber) || String(d.itemNumber || "").trim() || null,
    themePrimary: d.themePrimary || d.theme || null,
    yearReleased: d.yearReleased ?? d.year ?? null,
    launchDateMs: d.launchDateMs ?? null,
    catalogSortLaunch: d.catalogSortLaunch ?? null,
  };
}

const CONFIRM = hasFlag("confirm");
const DRY_QUEUE = hasFlag("dry-run") || hasFlag("queue-only");
const LIMIT = Math.max(1, Number(flagValue("limit", process.env.BO_LIMIT || "200")) || 200);
const MAX_MINUTES = Math.max(
  1,
  Number(flagValue("maxMinutes", process.env.BO_MAX_MINUTES || "25")) || 25
);
const CIRCUIT_FAILS = Math.max(2, Number(process.env.BO_CIRCUIT_FAILS || "4") || 4);
/** Брать из очереди кусками: взятое, но не снятое до конца окна, возвращается в очередь. */
const TAKE = Math.max(5, Number(process.env.BO_MONTH_QUEUE_TAKE) || 30);
/** Повторы ошибок идут в обычных залпах (как у BrickLink), до ~45% куска. */
const ERROR_BUDGET = Math.max(0, Number(process.env.BO_MONTH_QUEUE_ERROR_BUDGET ?? 12) || 0);
const WINDOW_DEFER_MS = Math.max(60_000, Number(process.env.BO_WINDOW_DEFER_MS) || 10 * 60 * 1000);

/** Owl без прокси по умолчанию: у каждого задания GitHub свой адрес, трафик прокси — BrickLink. */
function configureOwlProxy() {
  if (process.env.BO_USE_PROXY !== "1") {
    setProxyUrlOverride("");
    return null;
  }
  const raw = proxyEnvUrl();
  if (!raw) return null;
  const start = startPortInOwnRange(raw);
  setProxyUrlOverride(start);
  return start;
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const pauseRange = parsePauseMs();
  const queuePeriodId = utcYearMonth();
  const writePeriodId = lastClosedUtcYearMonth();
  const startedMs = Date.now();
  const deadlineMs = startedMs + MAX_MINUTES * 60 * 1000;
  let proxyUrl = configureOwlProxy();

  console.log(
    JSON.stringify({
      step: "brickowl_catalog_start",
      queuePeriodId,
      writePeriodId,
      confirm: CONFIRM,
      dryQueue: DRY_QUEUE,
      limit: LIMIT,
      maxMinutes: MAX_MINUTES,
      take: TAKE,
      errorBudget: ERROR_BUDGET,
      pauseMs: pauseRange,
      proxy: Boolean(proxyUrl),
      types: PRIMARY_TYPES,
    })
  );

  // Залп очередь не строит: только rebuild_owl_queue / build_queues.
  await ensureMonthQueue(db, admin, { periodId: queuePeriodId, source: "brickowl" });

  let retryQueued = 0;
  let queueRemaining = null;

  async function takeTasks(want) {
    const limit = Math.max(1, want);
    const errBudget = Math.min(ERROR_BUDGET, Math.floor(limit * 0.45));
    const taken = await takeFromMonthQueue(db, admin, {
      periodId: queuePeriodId,
      source: "brickowl",
      limit: Math.max(0, limit - errBudget),
      FieldValue,
      dryRun: !CONFIRM,
    });
    const due =
      errBudget > 0
        ? await takeDueMonthQueueErrors(db, admin, {
            periodId: queuePeriodId,
            source: "brickowl",
            limit: errBudget,
            FieldValue,
            dryRun: !CONFIRM,
          })
        : { ids: [] };
    queueRemaining = taken.remaining;
    retryQueued += due.ids?.length || 0;
    const ids = [...(due.ids || []), ...(taken.ids || [])];
    const cats = await loadCatalogDocsByIds(db, ids, mapCatalogDocLite, { source: "brickowl" });
    const byId = new Map(cats.map((c) => [c.catalogItemId, c]));
    const out = [];
    for (const id of ids) {
      const cat = byId.get(id);
      if (cat) out.push({ cat, retry: due.ids && due.ids.includes(id) });
    }
    console.log(
      JSON.stringify({
        step: "brickowl_queue_take",
        taken: taken.taken || 0,
        retry: due.ids?.length || 0,
        queued: out.length,
        remaining: taken.remaining ?? null,
      })
    );
    return out;
  }

  if (DRY_QUEUE || !CONFIRM) {
    const preview = await takeTasks(Math.min(LIMIT, TAKE));
    console.log("stop: need --confirm (or used --dry-run / --queue-only)");
    writeIngestArtifact("owl-catalog", {
      periodId: writePeriodId,
      queuePeriodId,
      queued: preview.length,
      processed: 0,
      ok: 0,
      noData: 0,
      fail: 0,
      dryRun: true,
    });
    return;
  }

  let ok = 0;
  let noData = 0;
  let fail = 0;
  let processed = 0;
  let uniquePriced = 0;
  let softBlocked = 0;
  let consecutiveSoftFails = 0;
  let proxyRotations = 0;
  let circuitTripped = false;
  let exhausted = false;
  let queued = 0;
  const statsAcc = createStatsAccumulator();
  let pending = [];

  async function processTask(task) {
    const cat = task.cat;
    const catalogItemId = cat.catalogItemId;
    const setNo = cat.itemNumber || setNoFromCatalogItemId(catalogItemId);

    let cachedOwlItemId = null;
    let cachedBoid = null;
    try {
      const snap = await db
        .collection("market_observations")
        .doc(observationDocId(catalogItemId, "brickowl"))
        .get();
      if (snap.exists) {
        const d = snap.data() || {};
        cachedOwlItemId = d.owlItemId ? String(d.owlItemId) : null;
        cachedBoid = d.boid ? String(d.boid) : null;
      }
    } catch {
      //
    }

    let fetched;
    try {
      fetched = await fetchBrickOwlPriceHistory({
        setNo,
        itemType: cat.itemType || "SET",
        boid: cachedBoid || undefined,
        owlItemId: cachedOwlItemId || undefined,
      });
    } catch (e) {
      fetched = {
        ok: false,
        errorTag: "bo_fetch_throw",
        error: String(e && e.message ? e.message : e),
      };
    }

    if (!fetched.ok) {
      const tag = fetched.errorTag || "bo_error";
      processed += 1;

      // Нет на Owl — честное пусто, не жара и не хвост ошибок.
      if (isOwlPermanentMiss(tag)) {
        noData += 1;
        consecutiveSoftFails = 0;
        try {
          await writeRawBrickOwlSixMonthAsLastClosed(
            db,
            admin.firestore,
            {
              catalogItemId,
              itemType: cat.itemType || "SET",
              setNo,
              soldNew: null,
              soldUsed: null,
              empty: true,
              method: fetched.method || "ajax_price_history_6m",
              errorTag: tag,
              boid: cachedBoid || null,
              owlItemId: cachedOwlItemId || null,
              periodId: writePeriodId,
            },
            { dryRun: false }
          );
        } catch (e) {
          console.warn("owl miss write failed", catalogItemId, e && e.message ? e.message : e);
        }
        statsAcc.add(cat.itemType, "empty");
        await trackMonthAnswer(db, statsAcc, {
          catalogItemId,
          itemType: cat.itemType,
          source: "brickowl",
          periodId: queuePeriodId,
          kind: "empty",
        });
        try {
          await clearMonthQueueError(db, queuePeriodId, catalogItemId, "brickowl");
        } catch {
          //
        }
        console.log(
          JSON.stringify({ step: "owl_no_match", catalogItemId, errorTag: tag, hops: fetched.hops })
        );
        return;
      }

      fail += 1;
      statsAcc.add(cat.itemType, isOwlSoftBlock(tag) ? "softBlocked" : "errors");
      try {
        await writeRawBrickOwlError(
          db,
          admin.firestore,
          {
            catalogItemId,
            itemType: cat.itemType || "SET",
            setNo,
            errorTag: tag,
            method: fetched.method || "ajax_price_history_6m",
            boid: cachedBoid || null,
            owlItemId: cachedOwlItemId || null,
            periodId: writePeriodId,
          },
          { dryRun: false }
        );
      } catch (e) {
        console.warn("owl error write failed", catalogItemId, e && e.message ? e.message : e);
      }
      try {
        await pushMonthQueueError(db, admin, {
          periodId: queuePeriodId,
          source: "brickowl",
          catalogItemId,
          errorTag: tag,
          error: fetched.error,
          FieldValue,
        });
      } catch {
        //
      }
      console.log(JSON.stringify({ step: "owl_fail", catalogItemId, errorTag: tag, hops: fetched.hops }));

      if (isOwlSoftBlock(tag)) {
        softBlocked += 1;
        consecutiveSoftFails += 1;
        const next = proxyUrl ? withRandomProxyPort(proxyUrl) : null;
        if (next) {
          proxyUrl = next;
          setProxyUrlOverride(next);
          proxyRotations += 1;
          console.log(JSON.stringify({ step: "owl_proxy_rotate", proxyRotations }));
        }
        if (consecutiveSoftFails >= CIRCUIT_FAILS) {
          circuitTripped = true;
          await markOwlCollectorHot(db, admin.firestore, tag);
          console.log(JSON.stringify({ step: "owl_circuit", consecutiveSoftFails, errorTag: tag }));
        }
      } else {
        consecutiveSoftFails = 0;
      }
      return;
    }

    consecutiveSoftFails = 0;
    const raw = await writeRawBrickOwlSixMonthAsLastClosed(
      db,
      admin.firestore,
      {
        catalogItemId,
        itemType: cat.itemType || "SET",
        setNo,
        soldNew: fetched.soldNew,
        soldUsed: fetched.soldUsed,
        empty: fetched.empty,
        method: fetched.method,
        boid: fetched.parsed?.boid || cachedBoid || null,
        owlItemId: fetched.catalogItemIdOwl || cachedOwlItemId || null,
        currencyHint: fetched.parsed?.currencyHint || null,
        periodId: writePeriodId,
      },
      { dryRun: false }
    );

    const answerKind = raw.status === "ok" ? "priced" : "empty";
    if (answerKind === "priced") ok += 1;
    else noData += 1;
    statsAcc.add(cat.itemType, answerKind === "priced" ? "gotPrice" : "empty");
    const answer = await trackMonthAnswer(db, statsAcc, {
      catalogItemId,
      itemType: cat.itemType,
      source: "brickowl",
      periodId: queuePeriodId,
      kind: answerKind,
    });
    if (answer.priced > 0) uniquePriced += 1;
    processed += 1;
    try {
      await clearMonthQueueError(db, queuePeriodId, catalogItemId, "brickowl");
    } catch {
      //
    }

    console.log(
      JSON.stringify({
        step: "owl_ok",
        catalogItemId,
        periodId: raw.periodId,
        status: raw.status,
        hops: fetched.hops,
        method: fetched.method,
      })
    );
  }

  while (processed < LIMIT && Date.now() < deadlineMs && !circuitTripped) {
    if (!pending.length) {
      pending = await takeTasks(Math.min(TAKE, LIMIT - processed));
      queued += pending.length;
      if (!pending.length) {
        exhausted = true;
        break;
      }
    }
    const task = pending.shift();
    await processTask(task);
    if (pending.length || processed < LIMIT) await sleep(randPause(pauseRange));
  }

  if (pending.length) {
    for (const task of pending) {
      try {
        await pushMonthQueueError(db, admin, {
          periodId: queuePeriodId,
          source: "brickowl",
          catalogItemId: task.cat.catalogItemId,
          errorTag: "window_defer",
          error: circuitTripped ? "owl_circuit" : "window_end",
          coolMs: WINDOW_DEFER_MS,
          FieldValue,
        });
      } catch (e) {
        console.warn("owl requeue failed", task.cat.catalogItemId, e && e.message ? e.message : e);
      }
    }
    console.log(JSON.stringify({ step: "owl_requeue_pending", count: pending.length }));
  }

  try {
    const t = statsAcc.totals();
    await bumpParserStats(
      db,
      admin.firestore,
      "brickowl",
      {
        requested: t.requested,
        gotPrice: t.gotPrice,
        empty: t.empty,
        errors: t.errors,
        softBlocked: t.softBlocked,
        uniquePriced: t.uniquePriced,
        byType: statsAcc.byType,
        uniqueByType: statsAcc.uniqueByType,
      },
      { periodId: queuePeriodId }
    );
  } catch (e) {
    console.warn("bumpParserStats owl failed:", e && e.message ? e.message : e);
  }

  const elapsedSec = Math.max(1, Math.round((Date.now() - startedMs) / 1000));
  const summary = {
    periodId: writePeriodId,
    queuePeriodId,
    queued,
    retryQueued,
    processed,
    ok,
    noData,
    fail,
    softBlocked,
    uniquePriced,
    proxyRotations,
    elapsedSec,
    circuitTripped,
    exhausted,
    remaining: queueRemaining,
  };
  writeIngestArtifact("owl-catalog", summary);
  console.log(JSON.stringify({ step: "brickowl_catalog_done", ...summary }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
