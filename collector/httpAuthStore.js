/**
 * Shared HTTP cookie jar for on-demand / bulk price refresh.
 * Doc: bif_ops/market_http_auth
 *
 * Written after Playwright warm-up (parser / GHA). Read by Cloud Functions for
 * plain HTTP Price Guide fetch — no warm Cloud Run.
 */
"use strict";

const COLLECTION = "bif_ops";
const DOC_ID = "bricklink_http_auth";
/** Prefer cookies younger than this for the fast path (6h). */
const FRESH_MS = 6 * 60 * 60 * 1000;

function authRef(db) {
  return db.collection(COLLECTION).doc(DOC_ID);
}

function tsMs(v) {
  if (!v) return 0;
  if (typeof v.toDate === "function") return v.toDate().getTime();
  if (typeof v === "string" || typeof v === "number") {
    const n = new Date(v).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  if (v._seconds != null) return Number(v._seconds) * 1000;
  return 0;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} FieldValue
 * @param {{ cookieHeader: string, userAgent?: string, source?: string }} payload
 */
async function saveHttpAuth(db, FieldValue, payload) {
  const cookieHeader = String(payload.cookieHeader || "").trim();
  if (!cookieHeader) return { ok: false, reason: "empty_cookie" };
  if (!/aws-waf-token=/i.test(cookieHeader) && !/blsecurity_/i.test(cookieHeader)) {
    // Still save — some sessions use other cookie names; HTTP path will fail soft.
  }
  await authRef(db).set(
    {
      cookieHeader,
      userAgent: String(payload.userAgent || "").trim() || null,
      source: String(payload.source || "parser").slice(0, 64),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { ok: true };
}

/**
 * @returns {Promise<{ cookieHeader: string, userAgent: string|null, updatedAtMs: number, fresh: boolean }|null>}
 */
async function loadHttpAuth(db, opts = {}) {
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : FRESH_MS;
  const snap = await authRef(db).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  const cookieHeader = String(d.cookieHeader || "").trim();
  if (!cookieHeader) return null;
  const updatedAtMs = tsMs(d.updatedAt);
  const age = updatedAtMs ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
  const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
  return {
    cookieHeader,
    userAgent: d.userAgent ? String(d.userAgent) : null,
    updatedAtMs,
    fresh,
    source: d.source || null,
  };
}

module.exports = {
  COLLECTION,
  DOC_ID,
  FRESH_MS,
  saveHttpAuth,
  loadHttpAuth,
};
