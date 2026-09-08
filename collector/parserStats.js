/**
 * Накопительные счётчики парсера (без полного обхода каталога).
 *
 * Doc: system_stats/bif_parser_stats_{YYYY-MM}
 *   catalogPrimary
 *   bySource.market|brickowl: { day*, month*, softBlocked, yerevanDay }
 *
 * День отчёта — календарный день Asia/Yerevan (как Telegram в 23:59).
 */
"use strict";

const { utcYearMonth } = require("./gapLedger");

const STATS_COLL = "system_stats";
const REPORT_TZ = "Asia/Yerevan";
const SOURCES = ["bricklink", "brickowl"];

function statsDocId(periodId) {
  return `bif_parser_stats_${periodId || utcYearMonth()}`;
}

function statsRef(db, periodId) {
  return db.collection(STATS_COLL).doc(statsDocId(periodId));
}

/** YYYY-MM-DD в Asia/Yerevan. */
function yerevanDayId(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function emptySourceBucket() {
  return {
    dayRequested: 0,
    dayGotPrice: 0,
    dayEmpty: 0,
    dayErrors: 0,
    daySoftBlocked: 0,
    monthRequested: 0,
    monthGotPrice: 0,
    monthEmpty: 0,
    monthErrors: 0,
    monthUniquePriced: 0,
    softBlocked: 0,
    yerevanDay: null,
  };
}

function normalizeSource(source) {
  const s = String(source || "").toLowerCase();
  if (s === "brickowl" || s === "owl" || s === "bo") return "brickowl";
  return "bricklink";
}

/**
 * Сброс дневных полей при смене дня Еревана (в транзакции / merge).
 */
function rollDayIfNeeded(bucket, day) {
  const b = { ...emptySourceBucket(), ...(bucket || {}) };
  if (String(b.yerevanDay || "") !== day) {
    b.dayRequested = 0;
    b.dayGotPrice = 0;
    b.dayEmpty = 0;
    b.dayErrors = 0;
    b.daySoftBlocked = 0;
    b.yerevanDay = day;
  }
  return b;
}

/**
 * Пакетный инкремент счётчиков залпа (1 транзакция на источник).
 * @param {{
 *   requested?: number,
 *   gotPrice?: number,
 *   empty?: number,
 *   errors?: number,
 *   softBlocked?: number,
 *   uniquePriced?: number,
 * }} delta
 */
async function bumpParserStats(db, firestoreNs, source, delta, opts = {}) {
  const FieldValue = firestoreNs.FieldValue;
  const src = normalizeSource(source);
  const periodId = opts.periodId || utcYearMonth();
  const day = opts.yerevanDay || yerevanDayId();
  const d = {
    requested: Math.max(0, Math.floor(Number(delta.requested) || 0)),
    gotPrice: Math.max(0, Math.floor(Number(delta.gotPrice) || 0)),
    empty: Math.max(0, Math.floor(Number(delta.empty) || 0)),
    errors: Math.max(0, Math.floor(Number(delta.errors) || 0)),
    softBlocked: Math.max(0, Math.floor(Number(delta.softBlocked) || 0)),
    uniquePriced: Math.max(0, Math.floor(Number(delta.uniquePriced) || 0)),
  };
  if (Object.values(d).every((n) => n === 0) && opts.catalogPrimary == null) return null;

  const ref = statsRef(db, periodId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() || {} : {};
    const bySource = { ...(prev.bySource || {}) };
    const bucket = rollDayIfNeeded(bySource[src], day);

    bucket.dayRequested += d.requested;
    bucket.dayGotPrice += d.gotPrice;
    bucket.dayEmpty += d.empty;
    bucket.dayErrors += d.errors;
    bucket.daySoftBlocked += d.softBlocked;
    bucket.monthRequested += d.requested;
    bucket.monthGotPrice += d.gotPrice;
    bucket.monthEmpty += d.empty;
    bucket.monthErrors += d.errors;
    bucket.monthUniquePriced += d.uniquePriced;
    bucket.softBlocked += d.softBlocked;
    bucket.yerevanDay = day;
    bySource[src] = bucket;

    const patch = {
      periodId,
      bySource,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (opts.catalogPrimary != null && Number.isFinite(Number(opts.catalogPrimary))) {
      patch.catalogPrimary = Math.max(0, Math.floor(Number(opts.catalogPrimary)));
    }
    tx.set(ref, patch, { merge: true });
    return { periodId, source: src, bucket, catalogPrimary: patch.catalogPrimary ?? prev.catalogPrimary };
  });

  console.log(
    JSON.stringify({
      step: "parser_stats_bump",
      periodId,
      source: src,
      delta: d,
      day,
    })
  );
  return result;
}

async function setCatalogPrimary(db, firestoreNs, catalogPrimary, opts = {}) {
  return bumpParserStats(db, firestoreNs, "bricklink", {}, {
    ...opts,
    catalogPrimary,
  });
}

/**
 * Было ли у позиции priced за текущий UTC-месяц до этой записи?
 * Нужно для monthUniquePriced (+1 только первый раз).
 */
async function wasUniquePricedThisMonth(db, catalogItemId, source, periodId) {
  const { observationDocId } = require("./catalogFields");
  const { observationHasPricedSignal } = require("./marketPoint");
  const src = normalizeSource(source);
  const obsId = observationDocId(catalogItemId, src);
  const snap = await db
    .collection("market_observations")
    .doc(obsId)
    .collection("monthly")
    .doc(periodId)
    .get();
  if (!snap.exists) return false;
  return observationHasPricedSignal(snap.data() || {});
}

async function readParserStats(db, periodId) {
  const pid = periodId || utcYearMonth();
  const snap = await statsRef(db, pid).get();
  const day = yerevanDayId();
  if (!snap.exists) {
    return {
      periodId: pid,
      catalogPrimary: null,
      yerevanDay: day,
      bySource: {
        bricklink: emptySourceBucket(),
        brickowl: emptySourceBucket(),
      },
    };
  }
  const d = snap.data() || {};
  const bySource = {};
  for (const s of SOURCES) {
    bySource[s] = rollDayIfNeeded(d.bySource?.[s], day);
  }
  return {
    periodId: pid,
    catalogPrimary: d.catalogPrimary != null ? Number(d.catalogPrimary) : null,
    yerevanDay: day,
    bySource,
  };
}

module.exports = {
  STATS_COLL,
  REPORT_TZ,
  SOURCES,
  statsDocId,
  statsRef,
  yerevanDayId,
  emptySourceBucket,
  normalizeSource,
  bumpParserStats,
  setCatalogPrimary,
  wasUniquePricedThisMonth,
  readParserStats,
};
