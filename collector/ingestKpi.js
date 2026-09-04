/**
 * Coverage KPI for Actions + Telegram report.
 * Главная метрика владельца: сколько РАЗНЫХ наборов+минифиг получили цену
 * в текущем календарном месяце UTC (не «скользящие 28 дней»).
 *
 *   npm run ingest:kpi -- --days=28 --write-run
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

/** Начало текущего UTC-месяца (мс). */
function utcMonthStartMs(d = new Date()) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const cutoffMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const monthStartMs = utcMonthStartMs();

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
  let errorBacklog = 0;
  let freshOkPrimary = 0;
  let freshNoDataPrimary = 0;
  let errorBacklogPrimary = 0;
  /** Разные primary с ценой, снятой в текущем UTC-месяце. */
  let monthOkPrimary = 0;
  let monthNoDataPrimary = 0;
  /** Primary с ценой в базе без ограничения по давности. */
  let anyOkPrimary = 0;
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
      const inMonth = capturedMs != null && capturedMs >= monthStartMs;

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

      if (isPrimary && st === "ok" && d.empty !== true) {
        anyOkPrimary += 1;
      }

      if (isPrimary && inMonth && (st === "ok" || st === "no_data")) {
        if (st === "no_data" || d.empty === true) monthNoDataPrimary += 1;
        else monthOkPrimary += 1;
      }
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }

  const freshCovered = freshOk + freshNoData;
  const staleOrMissing = Math.max(0, catalogTotal - freshCovered);
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
  const okPerDayTarget = Math.max(1, Number(process.env.BL_OK_PER_DAY_TARGET) || 2000);
  const pricedPctPrimary =
    catalogPrimary > 0 ? Math.round((freshOkPrimary / catalogPrimary) * 1000) / 10 : null;
  const monthPricedPctPrimary =
    catalogPrimary > 0 ? Math.round((monthOkPrimary / catalogPrimary) * 1000) / 10 : null;
  const anyPricedPctPrimary =
    catalogPrimary > 0 ? Math.round((anyOkPrimary / catalogPrimary) * 1000) / 10 : null;
  const okWithPricesPerDay =
    Number(run.okWithPrices) > 0
      ? Math.round((Number(run.okWithPrices) / runDays) * 10) / 10
      : null;
  const coverageTargetPct = Math.max(1, Number(process.env.BL_COVERAGE_TARGET_PCT) || 98);

  const prevMonthUnique = Number(run.monthUniqueWithPrices);
  const hadPrevMonthUnique = Number.isFinite(prevMonthUnique) && prevMonthUnique >= 0 && run.kpiUpdatedAt;
  const monthUniqueDelta = hadPrevMonthUnique
    ? monthOkPrimary - prevMonthUnique
    : null;

  const onTrack =
    monthPricedPctPrimary != null
      ? monthPricedPctPrimary >= coverageTargetPct ||
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
    /** Главное для отчёта: разные SET+MINIFIG с ценой, снятой в этом UTC-месяце. */
    monthOkPrimary,
    monthNoDataPrimary,
    monthPricedPctPrimary,
    monthUniqueDelta,
    anyOkPrimary,
    anyPricedPctPrimary,
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
    targetCoveragePct: coverageTargetPct,
    onTrack28d: onTrack,
    onTrack20d: onTrack,
    onTrack14d: onTrack,
  };

  console.log(`\n--- collector ${DAYS}d KPI ---`);
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
        monthOkPrimary,
        monthPricedPctPrimary,
        monthUniqueWithPrices: monthOkPrimary,
        anyOkPrimary,
        anyPricedPctPrimary,
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
      `## Collector ${periodId} month + ${DAYS}d KPI`,
      `- catalog primary (SET+MINIFIG): \`${catalogPrimary}\``,
      `- **month unique with prices**: \`${monthOkPrimary}\` (**${monthPricedPctPrimary ?? "n/a"}%**)`,
      `- month unique delta vs last KPI: \`${monthUniqueDelta ?? "n/a"}\``,
      `- rolling ${DAYS}d priced: \`${freshOkPrimary}\` (${pricedPctPrimary ?? "n/a"}%)`,
      `- ok-with-prices/day: \`${okWithPricesPerDay ?? "n/a"}\` (target >${okPerDayTarget})`,
      `- month run success%: \`${successPct ?? "n/a"}\` (ok ${run.ok || 0} / fail ${run.fail || 0})`,
      "",
    ];
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
