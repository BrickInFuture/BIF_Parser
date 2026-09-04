/**
 * BrickLink coverage KPI for Actions step summary + run doc (default 28 days).
 * Окно ≈ календарный месяц: цена «свежая», если снимали не старше ~месяца.
 *
 *   npm run ingest:bricklink:kpi -- --days=28
 *   npm run ingest:bricklink:kpi -- --days=28 --write-run
 */
"use strict";

const fs = require("fs");
const { initFirebaseAdmin } = require("./firebaseAdmin");
const { utcYearMonth } = require("./gapLedger");
const { runDocId, patchRun } = require("./checkpoint");
const { PRIMARY_TYPES } = require("./ingestTypes");
const { writeIngestArtifact } = require("./ingestReportArtifacts");

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const DAYS = Math.max(1, Number(flagValue("days", "28")) || 28);
const WRITE_RUN = hasFlag("write-run");

function tsToMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v._seconds === "number") return v._seconds * 1000;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avgSec(totalMs, count) {
  if (!count || !totalMs) return null;
  return Math.round((totalMs / count / 1000) * 10) / 10;
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const cutoffMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  let catalogTotal = 0;
  let catalogPrimary = 0;
  try {
    catalogTotal = (await db.collection("catalog_items").count().get()).data().count;
  } catch (e) {
    console.warn("catalog count failed:", e.message);
  }
  try {
    let lastCat = null;
    for (;;) {
      let q = db
        .collection("catalog_items")
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(400);
      if (lastCat) q = q.startAfter(lastCat);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const t = String((doc.data() || {}).itemType || "SET").toUpperCase();
        if (PRIMARY_TYPES.includes(t)) catalogPrimary += 1;
      }
      lastCat = snap.docs[snap.docs.length - 1];
      if (snap.size < 400) break;
    }
  } catch (e) {
    console.warn("catalog primary count failed:", e.message);
  }

  let freshOk = 0;
  let freshNoData = 0;
  let staleOrMissing = 0;
  let errorBacklog = 0;
  let freshOkPrimary = 0;
  let freshNoDataPrimary = 0;
  let errorBacklogPrimary = 0;
  let last = null;
  let freshOkCapturedMin = null;
  let freshOkCapturedMax = null;

  for (;;) {
    let q = db
      .collection("market_observations")
      .where("source", "==", "bricklink")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const st = String(d.status || "");
      const itemType = String(d.itemType || "SET").toUpperCase();
      const isPrimary = PRIMARY_TYPES.includes(itemType);
      const capturedMs = tsToMs(d.capturedAt) || tsToMs(d.updatedAt);
      const fresh = capturedMs != null && capturedMs >= cutoffMs;

      if (st === "error" || st === "fail") {
        errorBacklog += 1;
        if (isPrimary) errorBacklogPrimary += 1;
      }

      if ((st === "ok" || st === "no_data") && fresh) {
        if (st === "no_data" || d.empty === true) {
          freshNoData += 1;
          if (isPrimary) freshNoDataPrimary += 1;
        } else {
          freshOk += 1;
          if (isPrimary) freshOkPrimary += 1;
          if (capturedMs != null) {
            if (freshOkCapturedMin == null || capturedMs < freshOkCapturedMin) {
              freshOkCapturedMin = capturedMs;
            }
            if (freshOkCapturedMax == null || capturedMs > freshOkCapturedMax) {
              freshOkCapturedMax = capturedMs;
            }
          }
        }
      }
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }

  const freshCovered = freshOk + freshNoData;
  staleOrMissing = Math.max(0, catalogTotal - freshCovered);
  const coveragePct =
    catalogTotal > 0 ? Math.round((freshCovered / catalogTotal) * 1000) / 10 : null;

  const freshCoveredPrimary = freshOkPrimary + freshNoDataPrimary;
  const staleOrMissingPrimary = Math.max(0, catalogPrimary - freshCoveredPrimary);
  const coveragePctPrimary =
    catalogPrimary > 0
      ? Math.round((freshCoveredPrimary / catalogPrimary) * 1000) / 10
      : null;

  const runSnap = await db.collection("price_ingest_runs").doc(runDocId(periodId)).get();
  const run = runSnap.exists ? runSnap.data() || {} : {};
  const attempted = (Number(run.ok) || 0) + (Number(run.fail) || 0);
  const successPct = attempted > 0 ? Math.round((Number(run.ok) / attempted) * 1000) / 10 : null;

  const timing = run.timingStats || {};
  const avgSecOk = avgSec(Number(timing.okTotalMs) || 0, Number(timing.okCount) || 0);
  const avgSecSoft = avgSec(Number(timing.softTotalMs) || 0, Number(timing.softCount) || 0);

  // ok/day from month run ok spread over days since run started, else from fresh window.
  const runStartedMs = tsToMs(run.startedAt) || tsToMs(run.createdAt);
  const runDays =
    runStartedMs != null
      ? Math.max(1 / 24, (Date.now() - runStartedMs) / (24 * 60 * 60 * 1000))
      : DAYS;
  const okPerDayRun =
    Number(run.ok) > 0 ? Math.round((Number(run.ok) / runDays) * 10) / 10 : null;
  const freshSpanDays =
    freshOkCapturedMin != null && freshOkCapturedMax != null
      ? Math.max(1 / 24, (freshOkCapturedMax - freshOkCapturedMin) / (24 * 60 * 60 * 1000))
      : DAYS;
  const okPerDayFresh =
    freshOk > 0 ? Math.round((freshOk / Math.min(DAYS, freshSpanDays || DAYS)) * 10) / 10 : null;
  // Цель владельца: >2000 успешных цен в день.
  const okPerDayTarget = Math.max(
    1,
    Number(process.env.BL_OK_PER_DAY_TARGET) || 2000
  );
  // Price coverage only: no_data does not count toward the 95% priced target.
  const pricedPctPrimary =
    catalogPrimary > 0 ? Math.round((freshOkPrimary / catalogPrimary) * 1000) / 10 : null;
  const okWithPricesPerDay =
    Number(run.okWithPrices) > 0
      ? Math.round((Number(run.okWithPrices) / runDays) * 10) / 10
      : null;
  const onTrack =
    pricedPctPrimary != null
      ? pricedPctPrimary >= 95 ||
        (okWithPricesPerDay != null && okWithPricesPerDay >= okPerDayTarget * 0.75)
      : false;

  const kpi = {
    periodId,
    days: DAYS,
    catalogTotal,
    catalogPrimary,
    primaryTypes: PRIMARY_TYPES,
    freshOk,
    freshNoData,
    freshCovered,
    staleOrMissing,
    coveragePct,
    freshOkPrimary,
    freshNoDataPrimary,
    freshCoveredPrimary,
    staleOrMissingPrimary,
    coveragePctPrimary,
    pricedPctPrimary,
    errorBacklog,
    errorBacklogPrimary,
    okPerDay: okPerDayRun,
    okPerDayFresh,
    okPerDayWithPrices: okWithPricesPerDay,
    okPerDayTarget,
    avgSecOk,
    avgSecSoft,
    softAvgUnder8s: avgSecSoft == null ? null : avgSecSoft < 8,
    circuitTrips: Number(run.circuitTrips) || 0,
    ingestPhase: run.ingestPhase || null,
    primaryExhausted: run.primaryExhausted === true,
    runProcessed: Number(run.processed) || 0,
    runOk: Number(run.ok) || 0,
    runOkWithPrices: Number(run.okWithPrices) || 0,
    runNoData: Number(run.noData) || 0,
    runFail: Number(run.fail) || 0,
    runSuccessPct: successPct,
    runRetryLeft: Number(run.retryLeft) || 0,
    errorTagCounts: run.errorTagCounts || {},
    targetCoveragePct: 95,
    onTrack28d: onTrack,
    onTrack20d: onTrack,
    onTrack14d: onTrack,
  };

  console.log(`\n--- bricklink ${DAYS}d KPI ---`);
  console.log(JSON.stringify(kpi, null, 2));
  writeIngestArtifact("kpi", kpi);

  if (WRITE_RUN && runSnap.exists) {
    await patchRun(
      runSnap.ref,
      FieldValue,
      {
        coverageDays: DAYS,
        coveragePct,
        coveragePctPrimary,
        pricedPctPrimary,
        freshCovered,
        freshCoveredPrimary,
        freshOk,
        freshOkPrimary,
        freshNoData,
        freshNoDataPrimary,
        staleOrMissing,
        staleOrMissingPrimary,
        catalogPrimary,
        errorBacklog,
        errorBacklogPrimary,
        okPerDay: okPerDayRun,
        okPerDayWithPrices: okWithPricesPerDay,
        avgSecOk,
        avgSecSoft,
        circuitTrips: Number(run.circuitTrips) || 0,
        kpiUpdatedAt: FieldValue.serverTimestamp(),
      },
      false
    );
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const lines = [
      "",
      `## BrickLink ${DAYS}d coverage KPI`,
      `- primary types: \`${PRIMARY_TYPES.join(", ")}\``,
      `- catalog primary (SET+MINIFIG): \`${catalogPrimary}\``,
      `- fresh primary **with prices**: \`${freshOkPrimary}\` (**${pricedPctPrimary ?? "n/a"}%**)`,
      `- fresh primary ok+no_data: \`${freshCoveredPrimary}\` (${coveragePctPrimary ?? "n/a"}%)`,
      `- primary stale/missing prices: \`${Math.max(0, catalogPrimary - freshOkPrimary)}\``,
      `- primary error backlog: \`${errorBacklogPrimary}\``,
      `- catalog all types: \`${catalogTotal}\` (secondary deferred)`,
      `- ok-with-prices/day: \`${okWithPricesPerDay ?? "n/a"}\` (target >${okPerDayTarget})`,
      `- avgSec ok: \`${avgSecOk ?? "n/a"}\` · soft: \`${avgSecSoft ?? "n/a"}\` (goal soft &lt; 8s)`,
      `- circuitTrips: \`${Number(run.circuitTrips) || 0}\` · phase: \`${run.ingestPhase || "n/a"}\``,
      `- month run success%: \`${successPct ?? "n/a"}\` (ok ${run.ok || 0} / fail ${run.fail || 0})`,
      `- target: ≥95% fresh **priced** primary coverage in ${DAYS}d`,
      "",
    ];
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
