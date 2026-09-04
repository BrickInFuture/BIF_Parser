/**
 * Checkpoint / run state for monthly Catalog ingest.
 * Doc: price_ingest_runs/market_{periodId} (or …_s{N} for shards)
 */
"use strict";

const RUN_COLLECTION = "price_ingest_runs";

function runDocId(periodId, source = "bricklink") {
  return `${source}_${periodId}`;
}

function emptyRun(periodId) {
  return {
    source: "bricklink",
    itemType: "SET",
    ingestPhase: "primary",
    activeTypes: ["SET", "MINIFIG"],
    primaryExhausted: false,
    cursorType: "SET",
    periodId,
    status: "idle",
    cursorItemNumber: null,
    cursorCatalogId: null,
    processed: 0,
    ok: 0,
    fail: 0,
    skipped: 0,
    okWithPrices: 0,
    noData: 0,
    retryOk: 0,
    retryFail: 0,
    retryLeft: 0,
    lastError: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} periodId
 * @param {object} FieldValue
 * @param {{ reset?: boolean, dryRun?: boolean, runId?: string }} opts
 */
async function loadOrCreateRun(db, periodId, FieldValue, opts = {}) {
  const id = opts.runId || runDocId(periodId);
  const ref = db.collection(RUN_COLLECTION).doc(id);
  const snap = await ref.get();

  if (opts.reset || !snap.exists) {
    const base = emptyRun(periodId);
    base.status = "running";
    base.startedAt = FieldValue.serverTimestamp();
    base.updatedAt = FieldValue.serverTimestamp();
    if (!opts.dryRun) await ref.set(base, { merge: false });
    return { id, ref, data: { ...base, startedAt: new Date(), updatedAt: new Date() } };
  }

  const data = snap.data() || emptyRun(periodId);
  if (data.status === "done" && !opts.reset) {
    return { id, ref, data, alreadyDone: true };
  }

  const patch = {
    status: "running",
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!data.startedAt) patch.startedAt = FieldValue.serverTimestamp();
  if (!opts.dryRun) await ref.set(patch, { merge: true });
  return { id, ref, data: { ...data, ...patch } };
}

async function patchRun(ref, FieldValue, patch, dryRun) {
  const body = { ...patch, updatedAt: FieldValue.serverTimestamp() };
  if (dryRun) return body;
  await ref.set(body, { merge: true });
  return body;
}

module.exports = {
  RUN_COLLECTION,
  runDocId,
  emptyRun,
  loadOrCreateRun,
  patchRun,
};
