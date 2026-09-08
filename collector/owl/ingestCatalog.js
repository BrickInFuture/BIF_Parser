/**
 * Осторожный залп Brick Owl — только из месячной очереди (без скана каталога).
 *
 *   npm run ingest:brickowl:catalog -- --confirm --limit=60 --maxMinutes=20
 *
 * Канон: BIF_parser.md — limit≈20, пауза 2–4с, cool при жаре.
 */
"use strict";

const { initFirebaseAdmin } = require("../firebaseAdmin");
const { observationDocId } = require("../catalogFields");
const { lastClosedUtcYearMonth, utcYearMonth } = require("../gapLedger");
const {
  ensureMonthQueue,
  takeFromMonthQueue,
  pushMonthQueueError,
  clearMonthQueueError,
  loadCatalogDocsByIds,
  readMonthQueueMeta,
} = require("../monthQueue");
const {
  bumpParserStats,
  wasUniquePricedThisMonth,
} = require("../parserStats");
const { setNoFromCatalogItemId } = require("./boUrls");
const { fetchBrickOwlPriceHistory } = require("./fetchPriceHistory");
const { writeRawBrickOwlSixMonthAsLastClosed, writeRawBrickOwlError } = require("./writeRawObservation");
const { writeIngestArtifact } = require("../ingestReportArtifacts");
const { PRIMARY_TYPES } = require("./gapQueue");
const { markOwlCollectorHot } = require("./collectorGate");
const { normalizeSetNo } = require("../parseHtml");

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
  const raw = String(process.env.BO_PAUSE_MS || flagValue("pauseMs", "2000,4000"));
  const parts = raw.split(",").map((s) => Number(String(s).trim()));
  const a = Number.isFinite(parts[0]) ? Math.max(0, parts[0]) : 2000;
  const b = Number.isFinite(parts[1]) ? Math.max(a, parts[1]) : Math.max(a, 4000);
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
const LIMIT = Math.max(1, Number(flagValue("limit", process.env.BO_LIMIT || "60")) || 60);
const MAX_MINUTES = Math.max(
  1,
  Number(flagValue("maxMinutes", process.env.BO_MAX_MINUTES || "20")) || 20
);
const CIRCUIT_FAILS = Math.max(3, Number(process.env.BO_CIRCUIT_FAILS || "5") || 5);
/** Обычные залпы не мешают ошибки; хвост месяца — отдельно. */
const ERROR_BUDGET = Math.max(0, Number(process.env.BO_MONTH_QUEUE_ERROR_BUDGET) || 0);

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const pauseRange = parsePauseMs();
  const queuePeriodId = utcYearMonth();
  const writePeriodId = lastClosedUtcYearMonth();
  const startedMs = Date.now();
  const deadlineMs = startedMs + MAX_MINUTES * 60 * 1000;

  console.log(
    JSON.stringify({
      step: "brickowl_catalog_start",
      queuePeriodId,
      writePeriodId,
      confirm: CONFIRM,
      dryQueue: DRY_QUEUE,
      limit: LIMIT,
      maxMinutes: MAX_MINUTES,
      pauseMs: pauseRange,
      types: PRIMARY_TYPES,
    })
  );

  await ensureMonthQueue(db, admin, {
    periodId: queuePeriodId,
    source: "brickowl",
    checkMonthId: writePeriodId,
    types: PRIMARY_TYPES,
    mapCatalogDoc: mapCatalogDocLite,
    FieldValue,
    rebuild: false,
  });

  const mainBudget = Math.max(0, LIMIT - ERROR_BUDGET);
  const taken = await takeFromMonthQueue(db, admin, {
    periodId: queuePeriodId,
    source: "brickowl",
    limit: mainBudget,
    FieldValue,
    dryRun: !CONFIRM,
  });
  const due =
    ERROR_BUDGET > 0
      ? await require("../monthQueue").takeDueMonthQueueErrors(db, admin, {
          periodId: queuePeriodId,
          source: "brickowl",
          limit: ERROR_BUDGET,
          FieldValue,
          dryRun: !CONFIRM,
        })
      : { ids: [] };

  const ids = [...(due.ids || []), ...(taken.ids || [])];
  const cats = await loadCatalogDocsByIds(db, ids, mapCatalogDocLite, { source: "brickowl" });
  const byId = new Map(cats.map((c) => [c.catalogItemId, c]));
  const tasks = [];
  for (const id of ids) {
    const cat = byId.get(id);
    if (!cat) continue;
    tasks.push({ cat, retry: due.ids && due.ids.includes(id) });
  }

  const meta = await readMonthQueueMeta(db, queuePeriodId, "brickowl");
  console.log(
    JSON.stringify({
      step: "brickowl_queue",
      queued: tasks.length,
      taken: taken.taken || 0,
      retryQueued: due.ids?.length || 0,
      remaining: meta?.remaining ?? null,
      sample: tasks.slice(0, 5).map((t) => t.cat.catalogItemId),
    })
  );

  if (DRY_QUEUE || !CONFIRM) {
    console.log("stop: need --confirm (or used --dry-run / --queue-only)");
    writeIngestArtifact("owl-catalog", {
      periodId: writePeriodId,
      queuePeriodId,
      queued: tasks.length,
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
  let consecutiveFails = 0;
  let circuitTripped = false;

  for (const task of tasks) {
    if (Date.now() >= deadlineMs) {
      console.log(JSON.stringify({ step: "deadline", processed, ok, noData, fail }));
      break;
    }
    if (circuitTripped) break;

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
      fail += 1;
      consecutiveFails += 1;
      processed += 1;
      try {
        await writeRawBrickOwlError(
          db,
          admin.firestore,
          {
            catalogItemId,
            itemType: cat.itemType || "SET",
            setNo,
            errorTag: fetched.errorTag || "bo_error",
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
          errorTag: fetched.errorTag || "bo_error",
          error: fetched.error,
          FieldValue,
        });
      } catch {
        //
      }
      console.log(
        JSON.stringify({
          step: "owl_fail",
          catalogItemId,
          errorTag: fetched.errorTag,
          hops: fetched.hops,
        })
      );
      if (consecutiveFails >= CIRCUIT_FAILS) {
        circuitTripped = true;
        await markOwlCollectorHot(db, admin.firestore, fetched.errorTag || "owl_circuit");
        console.log(JSON.stringify({ step: "owl_circuit", consecutiveFails }));
      }
      await sleep(randPause(pauseRange));
      continue;
    }

    consecutiveFails = 0;
    let alreadyPriced = false;
    if (!fetched.empty) {
      try {
        alreadyPriced = await wasUniquePricedThisMonth(
          db,
          catalogItemId,
          "brickowl",
          writePeriodId
        );
      } catch {
        alreadyPriced = false;
      }
    }

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

    if (raw.status === "ok") {
      ok += 1;
      if (!alreadyPriced) uniquePriced += 1;
    } else noData += 1;
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

    await sleep(randPause(pauseRange));
  }

  try {
    await bumpParserStats(
      db,
      admin.firestore,
      "brickowl",
      {
        requested: processed,
        gotPrice: ok,
        empty: noData,
        errors: fail,
        softBlocked: circuitTripped ? consecutiveFails : 0,
        uniquePriced,
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
    queued: tasks.length,
    retryQueued: due.ids?.length || 0,
    processed,
    ok,
    noData,
    fail,
    uniquePriced,
    elapsedSec,
    circuitTripped,
  };
  writeIngestArtifact("owl-catalog", summary);
  console.log(JSON.stringify({ step: "brickowl_catalog_done", ...summary }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
