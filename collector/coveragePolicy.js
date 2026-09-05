/**
 * Coverage policy for bulk ingest.
 * Canonical product rules: ./PARSING_RULES.md
 *
 * Novelty (launch+2d … launch+365d): need a point for the current calendar month.
 * Mature (age ≥ 1y or no launch): scrape only if last market ok is older than 6 months.
 * Never scrape novelty before launch + 2 days.
 */
"use strict";

const {
  observationDocId,
  pickCatalogLaunchMs,
  pickCatalogRrpUsd,
  positiveUsdOrNull,
} = require("./catalogFields");

const DAY_MS = 24 * 60 * 60 * 1000;
const LAUNCH_MIN_AGE_MS = 2 * DAY_MS;
const NOVELTY_MAX_AGE_MS = 365 * DAY_MS;
const MATURE_TTL_MS = 180 * DAY_MS; // ~6 months (базовый для зрелых)
const RRP_BOOTSTRAP_METHOD = "rrp_bootstrap_0_9";
const RRP_BOOTSTRAP_FACTOR = 0.9;

/**
 * Тир свежести для зрелых наборов (совет эксперта: ликвидные обновлять чаще,
 * архив — реже). Ликвидность приближаем возрастом: недавние наборы волатильнее.
 *   • ликвидные (возраст < ~3 лет)   → короткий TTL (по умолчанию 60 дней)
 *   • обычные зрелые (3–10 лет)       → базовый TTL (180 дней)
 *   • архив (возраст > ~10 лет)       → длинный TTL (365 дней)
 * Все пороги/сроки настраиваются через переменные окружения.
 */
const MATURE_LIQUID_MAX_AGE_MS =
  (Number(process.env.BL_LIQUID_MAX_AGE_DAYS) || 365 * 3) * DAY_MS; // < 3 года
const MATURE_ARCHIVE_MIN_AGE_MS =
  (Number(process.env.BL_ARCHIVE_MIN_AGE_DAYS) || 365 * 10) * DAY_MS; // > 10 лет
const MATURE_TTL_LIQUID_MS =
  (Number(process.env.BL_LIQUID_TTL_DAYS) || 60) * DAY_MS;
const MATURE_TTL_ARCHIVE_MS =
  (Number(process.env.BL_ARCHIVE_TTL_DAYS) || 365) * DAY_MS;

/**
 * TTL «рыночного ok» для зрелого набора по его возрасту.
 * @param {number|null} ageMs
 * @returns {number}
 */
function matureTtlMsForAge(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return MATURE_TTL_MS;
  if (ageMs < MATURE_LIQUID_MAX_AGE_MS) return MATURE_TTL_LIQUID_MS;
  if (ageMs > MATURE_ARCHIVE_MIN_AGE_MS) return MATURE_TTL_ARCHIVE_MS;
  return MATURE_TTL_MS;
}

function tsToMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v._seconds === "number") return v._seconds * 1000;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} catalogItem
 * @param {number} [nowMs]
 * @returns {{ cohort: "too_early"|"novelty"|"mature", launchMs: number|null, ageMs: number|null }}
 */
function classifyCoverage(catalogItem, nowMs = Date.now()) {
  const launchMs = pickCatalogLaunchMs(catalogItem);
  if (launchMs == null || !Number.isFinite(launchMs)) {
    return { cohort: "mature", launchMs: null, ageMs: null };
  }
  const ageMs = nowMs - launchMs;
  if (ageMs < LAUNCH_MIN_AGE_MS) {
    return { cohort: "too_early", launchMs, ageMs };
  }
  if (ageMs < NOVELTY_MAX_AGE_MS) {
    return { cohort: "novelty", launchMs, ageMs };
  }
  return { cohort: "mature", launchMs, ageMs };
}

function isRrpBootstrapDoc(d) {
  if (!d || typeof d !== "object") return false;
  const method = String(d.method || "");
  const tag = String(d.errorTag || "");
  return method === RRP_BOOTSTRAP_METHOD || tag === RRP_BOOTSTRAP_METHOD;
}

/** Current-month coverage point for novelty: market ok OR rrp bootstrap. */
function monthlyHasCoveragePoint(monthly) {
  if (!monthly || typeof monthly !== "object") return false;
  const st = String(monthly.status || "");
  if (st === "ok") return true;
  if (isRrpBootstrapDoc(monthly)) return true;
  return false;
}

/**
 * Whether bulk ingest should skip scraping this catalog item.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ catalogItemId: string } & object} cat
 * @param {string} periodId YYYY-MM
 * @param {{ nowMs?: number }} [opts]
 */
async function resolveCatalogCoverage(db, cat, periodId, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const catalogItemId = String(cat.catalogItemId || "");
  const classif = classifyCoverage(cat, nowMs);
  const rrpUsd = pickCatalogRrpUsd(cat) ?? positiveUsdOrNull(cat.rrpUsd);

  if (classif.cohort === "too_early") {
    return {
      skip: true,
      reason: "launch_plus_2d_wait",
      cohort: classif.cohort,
      preferBootstrapIfEmpty: false,
      rrpUsd,
      launchMs: classif.launchMs,
    };
  }

  const obsId = observationDocId(catalogItemId, "bricklink");
  let monthly = null;
  try {
    const monthlySnap = await db
      .collection("market_observations")
      .doc(obsId)
      .collection("monthly")
      .doc(periodId)
      .get();
    if (monthlySnap.exists) monthly = monthlySnap.data() || {};
  } catch {
    monthly = null;
  }

  if (classif.cohort === "novelty") {
    if (monthlyHasCoveragePoint(monthly)) {
      return {
        skip: true,
        reason: "novelty_month_filled",
        cohort: classif.cohort,
        preferBootstrapIfEmpty: true,
        rrpUsd,
        launchMs: classif.launchMs,
      };
    }
    return {
      skip: false,
      reason: "novelty_need_month",
      cohort: classif.cohort,
      preferBootstrapIfEmpty: true,
      rrpUsd,
      launchMs: classif.launchMs,
    };
  }

  // mature: 6-month TTL on last successful market observation
  if (monthly && String(monthly.status || "") === "ok" && !isRrpBootstrapDoc(monthly)) {
    return {
      skip: true,
      reason: "mature_month_ok",
      cohort: classif.cohort,
      preferBootstrapIfEmpty: false,
      rrpUsd,
      launchMs: classif.launchMs,
    };
  }

  let obs = null;
  try {
    const obsSnap = await db.collection("market_observations").doc(obsId).get();
    if (obsSnap.exists) obs = obsSnap.data() || {};
  } catch {
    obs = null;
  }

  if (obs && String(obs.status || "") === "ok" && obs.empty !== true && !isRrpBootstrapDoc(obs)) {
    const ms = tsToMs(obs.capturedAt) || tsToMs(obs.updatedAt);
    const ttlMs = matureTtlMsForAge(classif.ageMs);
    if (ms != null && nowMs - ms < ttlMs) {
      return {
        skip: true,
        reason: "mature_fresh_6mo",
        cohort: classif.cohort,
        preferBootstrapIfEmpty: false,
        rrpUsd,
        launchMs: classif.launchMs,
        ttlMs,
      };
    }
  }

  return {
    skip: false,
    reason: "mature_stale",
    cohort: classif.cohort,
    preferBootstrapIfEmpty: false,
    rrpUsd,
    launchMs: classif.launchMs,
  };
}

module.exports = {
  DAY_MS,
  LAUNCH_MIN_AGE_MS,
  NOVELTY_MAX_AGE_MS,
  MATURE_TTL_MS,
  MATURE_TTL_LIQUID_MS,
  MATURE_TTL_ARCHIVE_MS,
  MATURE_LIQUID_MAX_AGE_MS,
  MATURE_ARCHIVE_MIN_AGE_MS,
  matureTtlMsForAge,
  RRP_BOOTSTRAP_METHOD,
  RRP_BOOTSTRAP_FACTOR,
  classifyCoverage,
  isRrpBootstrapDoc,
  monthlyHasCoveragePoint,
  resolveCatalogCoverage,
  tsToMs,
};
