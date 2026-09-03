/**
 * Проверка шага 2: у набора есть monthly за несколько UTC-месяцев.
 *   node scripts/bricklink-parser/verifyMonthlyStep2.js
 *   node scripts/bricklink-parser/verifyMonthlyStep2.js --ids=SET_75192-1,SET_10003-1
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { observationDocId } = require("./catalogFields");
const { utcYearMonth, closedUtcMonthsBack } = require("./gapLedger");
const { ledgerStatusFromMonthly } = require("./marketPoint");

function flagValue(name, fallback = null) {
  const hit = process.argv.find((a) => String(a).startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function loadMonthlyMap(db, obsId, periodIds) {
  const col = db.collection("market_observations").doc(obsId).collection("monthly");
  const refs = periodIds.map((pid) => col.doc(pid));
  const snaps = await db.getAll(...refs);
  const map = {};
  for (const snap of snaps) {
    if (snap.exists) map[snap.id] = snap.data() || {};
  }
  return map;
}

async function main() {
  const { db } = initFirebaseAdmin();
  const current = utcYearMonth();
  const check = closedUtcMonthsBack(current, 6);
  const idsCsv = flagValue("ids", "");
  let ids = idsCsv
    ? idsCsv.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  if (!ids.length) {
    const snap = await db
      .collection("catalog_items")
      .where("itemType", "==", "SET")
      .orderBy(require("firebase-admin").firestore.FieldPath.documentId())
      .limit(12)
      .get();
    ids = snap.docs.map((d) => d.id);
  }

  const rows = [];
  for (const catalogItemId of ids) {
    const obsId = observationDocId(catalogItemId, "bricklink");
    const monthly = await loadMonthlyMap(db, obsId, check);
    const filled = check.filter((pid) => {
      const doc = monthly[pid];
      return doc && ledgerStatusFromMonthly(doc) !== "gap";
    });
    rows.push({
      catalogItemId,
      filled: filled.length,
      periods: filled,
      missing: check.filter((pid) => !filled.includes(pid)),
    });
  }

  console.log(
    JSON.stringify(
      {
        step: "verify_monthly_step2",
        currentUtc: current,
        checkMonths: check,
        multiMonth: rows.filter((r) => r.filled >= 2).length,
        rows,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
