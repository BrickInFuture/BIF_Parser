/**
 * Gate для kick Brick Owl (отдельно от BrickLink).
 * Doc: system_stats/bif_owl_collector_gate
 */
"use strict";

const GATE_COLLECTION = "system_stats";
const GATE_DOC = "bif_owl_collector_gate";

const HOT_COOL_MS = Math.max(
  60_000,
  Number(process.env.BO_HOT_UNTIL_MS) || 2 * 60 * 60 * 1000
);

function gateRef(db) {
  return db.collection(GATE_COLLECTION).doc(GATE_DOC);
}

async function markOwlCollectorHot(db, firestoreNs, reason, coolMs = HOT_COOL_MS) {
  const FieldValue = firestoreNs.FieldValue;
  const until = Date.now() + Math.max(60_000, Number(coolMs) || HOT_COOL_MS);
  await gateRef(db).set(
    {
      hotUntilMs: until,
      reason: String(reason || "circuit").slice(0, 120),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(
    JSON.stringify({
      step: "owl_collector_hot_until",
      hotUntilMs: until,
      coolMin: Math.round((until - Date.now()) / 60000),
      reason: String(reason || "circuit").slice(0, 80),
    })
  );
  return until;
}

async function readOwlCollectorHot(db) {
  const snap = await gateRef(db).get();
  if (!snap.exists) return { hot: false, hotUntilMs: null, reason: null };
  const d = snap.data() || {};
  const until = Number(d.hotUntilMs) || 0;
  return {
    hot: until > Date.now(),
    hotUntilMs: until || null,
    reason: d.reason ? String(d.reason) : null,
  };
}

module.exports = {
  markOwlCollectorHot,
  readOwlCollectorHot,
  HOT_COOL_MS,
  GATE_DOC,
};
