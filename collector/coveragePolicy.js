/**
 * Coverage policy for bulk ingest.
 * Canonical product rules: ./PARSING_RULES.md + BIF_parser.md
 *
 * Все SET+MINIFIG (кроме «ещё не вышел +2 дня»): нужна точка за **текущий** UTC-месяц.
 * Один успешный съём в месяц закрывает набор (ok / no_data / bootstrap) — не крутим снова.
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
/** @deprecated раньше TTL зрелых; сейчас цель — раз в календарный месяц. */
const MATURE_TTL_MS = 180 * DAY_MS;
const RRP_BOOTSTRAP_METHOD = "rrp_bootstrap_0_9";
const RRP_BOOTSTRAP_FACTOR = 0.9;

/**
 * Тир свежести (справочно / env); bulk-очередь больше не пропускает по TTL —
 * всем нужен текущий месяц. Оставлено для совместимости и редких ручных режимов.
 */
const MATURE_LIQUID_MAX_AGE_MS =
  (Number(process.env.BL_LIQUID_MAX_AGE_DAYS) || 365 * 3) * DAY_MS;
const MATURE_ARCHIVE_MIN_AGE_MS =
  (Number(process.env.BL_ARCHIVE_MIN_AGE_DAYS) || 365 * 10) * DAY_MS;
const MATURE_TTL_LIQUID_MS =
  (Number(process.env.BL_LIQUID_TTL_DAYS) || 60) * DAY_MS;
const MATURE_TTL_ARCHIVE_MS =
  (Number(process.env.BL_ARCHIVE_TTL_DAYS) || 365) * DAY_MS;

/**
 * TTL «рыночного ok» для зрелого набора по его возрасту (справочно).
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

/**
 * Месяц уже «пройден» для bulk: есть рынок, пусто после просмотра, или bootstrap.
 * Plain no_data = смотрели, на BL пусто — повтор в том же месяце не нужен.
 */
function monthlyHasCoveragePoint(monthly) {
  if (!monthly || typeof monthly !== "object") return false;
  if (isRrpBootstrapDoc(monthly)) return true;
  const st = String(monthly.status || "");
  if (st === "ok" || st === "no_data") return true;
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
  const preferBootstrapIfEmpty = classif.cohort === "novelty";

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

  if (monthlyHasCoveragePoint(monthly)) {
    return {
      skip: true,
      reason: classif.cohort === "novelty" ? "novelty_month_filled" : "month_filled",
      cohort: classif.cohort,
      preferBootstrapIfEmpty,
      rrpUsd,
      launchMs: classif.launchMs,
    };
  }

  return {
    skip: false,
    reason: classif.cohort === "novelty" ? "novelty_need_month" : "need_current_month",
    cohort: classif.cohort,
    preferBootstrapIfEmpty,
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
