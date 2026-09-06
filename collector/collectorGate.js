/**
 * Gate for Firebase kickBifCollector: pause dispatches while market IP is hot.
 * Doc: system_stats/bif_collector_gate { hotUntilMs, reason, updatedAt }
 * Pace: system_stats/bif_collector_pace { utcDay, okWithPrices }
 */
"use strict";

const GATE_COLLECTION = "system_stats";
const GATE_DOC = "bif_collector_gate";
const PACE_DOC = "bif_collector_pace";

/** How long kick skips after a soft-block / circuit wave (ms). */
const HOT_COOL_MS = Math.max(
  60_000,
  Number(process.env.BL_HOT_UNTIL_MS) || 60 * 60 * 1000
);

const DAY_PACE_TARGET = Math.max(1, Number(process.env.BL_OK_PER_DAY_TARGET) || 1150);

function utcDayId(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function gateRef(db) {
  return db.collection(GATE_COLLECTION).doc(GATE_DOC);
}

function paceRef(db) {
  return db.collection(GATE_COLLECTION).doc(PACE_DOC);
}

/**
 * Mark collector IP hot so scheduled kicks skip until hotUntilMs.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ FieldValue: any }} firestoreNs
 * @param {string} reason
 * @param {number=} coolMs
 */
async function markCollectorHot(db, firestoreNs, reason, coolMs = HOT_COOL_MS) {
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
      step: "collector_hot_until",
      hotUntilMs: until,
      coolMin: Math.round((until - Date.now()) / 60000),
      reason: String(reason || "circuit").slice(0, 80),
    })
  );
  return until;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<{ hot: boolean, hotUntilMs: number|null, reason: string|null }>}
 */
async function readCollectorHot(db) {
  const snap = await gateRef(db).get();
  if (!snap.exists) return { hot: false, hotUntilMs: null, reason: null };
  const d = snap.data() || {};
  const until = Number(d.hotUntilMs) || 0;
  const hot = until > Date.now();
  return {
    hot,
    hotUntilMs: until || null,
    reason: d.reason ? String(d.reason) : null,
  };
}

/**
 * Add successful priced scrapes to today's UTC pace counter.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ FieldValue: any }} firestoreNs
 * @param {number} delta
 */
async function bumpDayPace(db, firestoreNs, delta) {
  const n = Math.max(0, Math.floor(Number(delta) || 0));
  if (!n) return null;
  const FieldValue = firestoreNs.FieldValue;
  const day = utcDayId();
  const ref = paceRef(db);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() || {} : {};
    let total = Number(prev.okWithPrices) || 0;
    if (String(prev.utcDay || "") !== day) total = 0;
    total += n;
    tx.set(
      ref,
      {
        utcDay: day,
        okWithPrices: total,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { utcDay: day, okWithPrices: total };
  });
  console.log(JSON.stringify({ step: "day_pace_bump", ...result, delta: n }));
  return result;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<{ utcDay: string|null, okWithPrices: number, target: number }>}
 */
async function readDayPace(db) {
  const day = utcDayId();
  const snap = await paceRef(db).get();
  if (!snap.exists) return { utcDay: day, okWithPrices: 0, target: DAY_PACE_TARGET };
  const d = snap.data() || {};
  if (String(d.utcDay || "") !== day) {
    return { utcDay: day, okWithPrices: 0, target: DAY_PACE_TARGET };
  }
  return {
    utcDay: day,
    okWithPrices: Number(d.okWithPrices) || 0,
    target: DAY_PACE_TARGET,
  };
}

module.exports = {
  GATE_COLLECTION,
  GATE_DOC,
  PACE_DOC,
  HOT_COOL_MS,
  DAY_PACE_TARGET,
  utcDayId,
  markCollectorHot,
  readCollectorHot,
  bumpDayPace,
  readDayPace,
};
