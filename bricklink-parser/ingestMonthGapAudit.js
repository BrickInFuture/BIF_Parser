/**
 * Audit monthly price-point gaps (especially novelty first-year months).
 *
 *   npm run ingest:bricklink:month-gaps
 *   npm run ingest:bricklink:month-gaps -- --types=SET --limitPrint=30
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { utcYearMonth } = require("./gapLedger");
const {
  pickCatalogLaunchMs,
  observationDocId,
} = require("./catalogFields");
const {
  classifyCoverage,
  monthlyHasCoveragePoint,
  LAUNCH_MIN_AGE_MS,
  NOVELTY_MAX_AGE_MS,
} = require("./coveragePolicy");

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return fallback;
}

const TYPES = String(flagValue("types", "SET") || "SET")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LIMIT_PRINT = Math.max(1, Number(flagValue("limitPrint", "40")) || 40);

function periodOffset(periodId, deltaMonths) {
  const [y, m] = String(periodId).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function monthsBetweenInclusive(fromMs, toMs) {
  const out = [];
  const start = new Date(fromMs);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const end = new Date(toMs);
  const endKey = end.getUTCFullYear() * 12 + end.getUTCMonth();
  for (;;) {
    const key = y * 12 + m;
    if (key > endKey) break;
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    if (out.length > 24) break;
  }
  return out;
}

async function main() {
  const { admin, db } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const nowMs = Date.now();

  const summary = {
    periodId,
    scanned: 0,
    byCohort: { too_early: 0, novelty: 0, mature: 0 },
    noveltyMissingCurrentMonth: 0,
    noveltyZeroPoints: 0,
    matureNoOkEver: 0,
    sampleNoveltyGaps: [],
  };

  for (const itemType of TYPES) {
    let last = null;
    for (;;) {
      let q = db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(200);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        summary.scanned += 1;
        const cat = { catalogItemId: doc.id, ...(doc.data() || {}) };
        const classif = classifyCoverage(cat, nowMs);
        summary.byCohort[classif.cohort] = (summary.byCohort[classif.cohort] || 0) + 1;

        const obsId = observationDocId(doc.id, "bricklink");
        const monthlyCol = db.collection("market_observations").doc(obsId).collection("monthly");

        if (classif.cohort === "novelty" && classif.launchMs != null) {
          const scrapeStart = classif.launchMs + LAUNCH_MIN_AGE_MS;
          const scrapeEnd = Math.min(nowMs, classif.launchMs + NOVELTY_MAX_AGE_MS);
          const needMonths = monthsBetweenInclusive(scrapeStart, scrapeEnd);
          let filled = 0;
          let missingCurrent = false;
          for (const pid of needMonths) {
            const mSnap = await monthlyCol.doc(pid).get();
            const ok = mSnap.exists && monthlyHasCoveragePoint(mSnap.data() || {});
            if (ok) filled += 1;
            else if (pid === periodId) missingCurrent = true;
          }
          if (filled === 0) summary.noveltyZeroPoints += 1;
          if (missingCurrent) {
            summary.noveltyMissingCurrentMonth += 1;
            if (summary.sampleNoveltyGaps.length < LIMIT_PRINT) {
              summary.sampleNoveltyGaps.push({
                id: doc.id,
                itemNumber: cat.itemNumber || null,
                missing: periodId,
                filledMonths: filled,
                needMonths: needMonths.length,
              });
            }
          }
        } else if (classif.cohort === "mature") {
          const obsSnap = await db.collection("market_observations").doc(obsId).get();
          const obs = obsSnap.exists ? obsSnap.data() || {} : null;
          const hasOk =
            obs &&
            String(obs.status || "") === "ok" &&
            obs.empty !== true;
          if (!hasOk) summary.matureNoOkEver += 1;
        }
      }

      last = snap.docs[snap.docs.length - 1];
      if (snap.size < 200) break;
    }
  }

  console.log(JSON.stringify({ step: "month_gap_audit", ...summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
