/**
 * Накопительные счётчики парсера (без полного обхода каталога).
 *
 * Doc: system_stats/bif_parser_stats_{YYYY-MM}
 *   catalogPrimary
 *   bySource.market|brickowl: {
 *     day*, month*, softBlocked, yerevanDay,
 *     monthByType.{SET|MINIFIG|GEAR|OTHER}: { requested, gotPrice, empty, errors, softBlocked } — попытки
 *     monthUniqueByType.{…}: { priced, empty } — разные позиции с ответом за месяц
 *     days.{YYYY-MM-DD}: { requested, gotPrice, empty, errors, softBlocked } — история по дням Еревана
 *   }
 *
 * «Ответ за месяц» помечается на корне observation (statsAnswerPeriod / statsAnswerKind),
 * чтобы повторный съём той же позиции не считался второй раз.
 *
 * День отчёта — календарный день Asia/Yerevan (как Telegram в 23:59).
 */
"use strict";

const { utcYearMonth } = require("./gapLedger");

const STATS_COLL = "system_stats";
const REPORT_TZ = "Asia/Yerevan";
const SOURCES = ["bricklink", "brickowl"];
const STAT_TYPES = ["SET", "MINIFIG", "GEAR", "OTHER"];
const ATTEMPT_FIELDS = ["requested", "gotPrice", "empty", "errors", "softBlocked"];
const DAYS_KEEP = 40;

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

function statType(itemType) {
  const t = String(itemType || "SET").toUpperCase();
  return STAT_TYPES.includes(t) ? t : "OTHER";
}

function emptyAttempts() {
  return { requested: 0, gotPrice: 0, empty: 0, errors: 0, softBlocked: 0 };
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
    monthByType: {},
    monthUniqueByType: {},
    days: {},
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
 * Накопитель одного залпа: попытки и новые ответы по типам.
 * add(type, "gotPrice") — попытка с ценой; unique(type, delta) — из answerDelta.
 */
function createStatsAccumulator() {
  const byType = {};
  const uniqueByType = {};
  const ensure = (map, t, init) => {
    if (!map[t]) map[t] = init();
    return map[t];
  };
  return {
    byType,
    uniqueByType,
    add(itemType, field) {
      const row = ensure(byType, statType(itemType), emptyAttempts);
      row.requested += 1;
      if (field && field !== "requested") row[field] += 1;
    },
    unique(itemType, delta) {
      if (!delta || (!delta.priced && !delta.empty)) return;
      const row = ensure(uniqueByType, statType(itemType), () => ({ priced: 0, empty: 0 }));
      row.priced += delta.priced || 0;
      row.empty += delta.empty || 0;
    },
    totals() {
      const t = emptyAttempts();
      let uniquePriced = 0;
      for (const row of Object.values(byType)) {
        for (const f of ATTEMPT_FIELDS) t[f] += row[f] || 0;
      }
      for (const row of Object.values(uniqueByType)) uniquePriced += row.priced || 0;
      return { ...t, uniquePriced };
    },
  };
}

/**
 * Прошлый ответ позиции в этом месяце (по данным корня observation, без лишнего чтения,
 * если корень уже прочитан — передай его data).
 * @returns {null|"priced"|"empty"}
 */
function prevAnswerFromObservation(data, periodId) {
  if (!data || String(data.statsAnswerPeriod || "") !== String(periodId)) return null;
  const k = String(data.statsAnswerKind || "");
  return k === "priced" || k === "empty" ? k : null;
}

async function readMonthAnswer(db, catalogItemId, source, periodId) {
  const { observationDocId } = require("./catalogFields");
  const snap = await db
    .collection("market_observations")
    .doc(observationDocId(catalogItemId, normalizeSource(source)))
    .get();
  return prevAnswerFromObservation(snap.exists ? snap.data() : null, periodId);
}

/** Сколько добавить в «разные позиции с ответом»: первый ответ или пусто → цена. */
function answerDelta(prevKind, kind) {
  if (kind !== "priced" && kind !== "empty") return { priced: 0, empty: 0, changed: false };
  if (!prevKind) {
    return kind === "priced"
      ? { priced: 1, empty: 0, changed: true }
      : { priced: 0, empty: 1, changed: true };
  }
  if (prevKind === "empty" && kind === "priced") return { priced: 1, empty: -1, changed: true };
  return { priced: 0, empty: 0, changed: false };
}

async function markMonthAnswer(db, catalogItemId, source, periodId, kind) {
  const { observationDocId } = require("./catalogFields");
  await db
    .collection("market_observations")
    .doc(observationDocId(catalogItemId, normalizeSource(source)))
    .set({ statsAnswerPeriod: String(periodId), statsAnswerKind: kind }, { merge: true });
}

/** Прочитать прошлый ответ → посчитать дельту → пометить корень (1 чтение + ≤1 запись). */
async function trackMonthAnswer(db, acc, { catalogItemId, itemType, source, periodId, kind, prevKind }) {
  let prev = prevKind;
  if (prev === undefined) {
    try {
      prev = await readMonthAnswer(db, catalogItemId, source, periodId);
    } catch {
      prev = null;
    }
  }
  const delta = answerDelta(prev, kind);
  if (!delta.changed) return delta;
  acc.unique(itemType, delta);
  try {
    await markMonthAnswer(db, catalogItemId, source, periodId, kind);
  } catch (e) {
    console.warn("markMonthAnswer failed", catalogItemId, e && e.message ? e.message : e);
  }
  return delta;
}

function addInto(target, delta, fields) {
  const out = { ...(target || {}) };
  for (const f of fields) out[f] = (Number(out[f]) || 0) + (Number(delta[f]) || 0);
  return out;
}

/**
 * Пакетный инкремент счётчиков залпа (1 транзакция на источник).
 * @param {{
 *   requested?: number, gotPrice?: number, empty?: number, errors?: number,
 *   softBlocked?: number, uniquePriced?: number,
 *   byType?: Record<string, object>, uniqueByType?: Record<string, {priced:number, empty:number}>,
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
  const byType = delta.byType || {};
  const uniqueByType = delta.uniqueByType || {};
  const hasTyped = Object.keys(byType).length > 0 || Object.keys(uniqueByType).length > 0;
  if (Object.values(d).every((n) => n === 0) && !hasTyped && opts.catalogPrimary == null) return null;

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

    const mbt = { ...(bucket.monthByType || {}) };
    for (const [t, row] of Object.entries(byType)) {
      mbt[statType(t)] = addInto(mbt[statType(t)], row, ATTEMPT_FIELDS);
    }
    bucket.monthByType = mbt;

    const mut = { ...(bucket.monthUniqueByType || {}) };
    for (const [t, row] of Object.entries(uniqueByType)) {
      const next = addInto(mut[statType(t)], row, ["priced", "empty"]);
      next.priced = Math.max(0, next.priced);
      next.empty = Math.max(0, next.empty);
      mut[statType(t)] = next;
    }
    bucket.monthUniqueByType = mut;

    const days = { ...(bucket.days || {}) };
    days[day] = addInto(days[day], d, ATTEMPT_FIELDS);
    const keys = Object.keys(days).sort();
    while (keys.length > DAYS_KEEP) delete days[keys.shift()];
    bucket.days = days;

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
      byType,
      uniqueByType,
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
    bySource[s] = { ...emptySourceBucket(), ...(d.bySource?.[s] || {}) };
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
  STAT_TYPES,
  ATTEMPT_FIELDS,
  statsDocId,
  statsRef,
  yerevanDayId,
  statType,
  emptyAttempts,
  emptySourceBucket,
  normalizeSource,
  rollDayIfNeeded,
  createStatsAccumulator,
  prevAnswerFromObservation,
  readMonthAnswer,
  answerDelta,
  markMonthAnswer,
  trackMonthAnswer,
  bumpParserStats,
  setCatalogPrimary,
  wasUniquePricedThisMonth,
  readParserStats,
};
