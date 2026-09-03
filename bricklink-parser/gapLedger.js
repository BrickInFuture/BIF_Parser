/**
 * Ledger дыр: какие месяцы «должны быть» у набора и закрыты ли они.
 * Канон: BIF_parser.md § «Ledger».
 *
 * gap — месяц в диапазоне, но нет записи или нет sold/stock/no_data.
 */
"use strict";

const { LEDGER_STATUS, ledgerStatusFromMonthly } = require("./marketPoint");
const { LAUNCH_MIN_AGE_MS } = require("./coveragePolicy");

function parsePeriodId(periodId) {
  const [y, m] = String(periodId).split("-").map(Number);
  return { year: y, month: m };
}

function formatPeriodId(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Текущий календарный месяц UTC (YYYY-MM). Метки «August 2026» на BL → UTC. */
function utcYearMonth(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  return formatPeriodId(dt.getUTCFullYear(), dt.getUTCMonth() + 1);
}

/** Последний полностью закрытый месяц UTC (для записи sold из HTML). */
function lastClosedUtcYearMonth(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const anchor = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1));
  anchor.setUTCMonth(anchor.getUTCMonth() - 1);
  return formatPeriodId(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1);
}

/** N календарных месяцев назад от periodId, включая стартовый. */
function closedUtcMonthsBack(fromPeriodId, count) {
  const n = Math.max(0, Number(count) || 0);
  const out = [];
  let pid = String(fromPeriodId || "");
  for (let i = 0; i < n && pid; i += 1) {
    out.push(pid);
    pid = addMonthsToPeriod(pid, -1);
  }
  return out;
}

function addMonthsToPeriod(periodId, delta) {
  const { year, month } = parsePeriodId(periodId);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return formatPeriodId(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/**
 * Календарные месяцы от fromMs до toMs (UTC), включительно.
 * @param {number} fromMs
 * @param {number} toMs
 * @param {{ maxMonths?: number }} [opts]
 */
function periodIdsBetween(fromMs, toMs, opts = {}) {
  const maxMonths = opts.maxMonths != null ? opts.maxMonths : 600;
  const start = new Date(fromMs);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const end = new Date(toMs);
  const endKey = end.getUTCFullYear() * 12 + end.getUTCMonth();
  const out = [];
  for (;;) {
    const key = y * 12 + m;
    if (key > endKey) break;
    out.push(formatPeriodId(y, m + 1));
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    if (out.length >= maxMonths) break;
  }
  return out;
}

/**
 * Месяцы, которые логично ожидать для набора (от launch+2d до сейчас).
 * @param {{ launchDateMs?: number|null }} catalogItem
 * @param {number} [nowMs]
 */
function expectedPeriodIdsForItem(catalogItem, nowMs = Date.now()) {
  const launchMs = Number(catalogItem?.launchDateMs);
  if (!Number.isFinite(launchMs) || launchMs <= 0) {
    return periodIdsBetween(nowMs - 365 * 24 * 60 * 60 * 1000, nowMs, { maxMonths: 24 });
  }
  const fromMs = launchMs + LAUNCH_MIN_AGE_MS;
  if (fromMs > nowMs) return [];
  return periodIdsBetween(fromMs, nowMs);
}

/**
 * Одна ячейка ledger: набор × месяц.
 * @param {string} periodId
 * @param {object|null|undefined} monthlyDoc — документ из Firestore или null
 */
function classifyPeriodSlot(periodId, monthlyDoc) {
  if (!monthlyDoc) {
    return { periodId, status: LEDGER_STATUS.GAP, closed: false };
  }
  const status = ledgerStatusFromMonthly(monthlyDoc);
  const closed =
    status === LEDGER_STATUS.OK_SOLD ||
    status === LEDGER_STATUS.OK_STOCK ||
    status === LEDGER_STATUS.NO_DATA ||
    status === LEDGER_STATUS.BOOTSTRAP ||
    status === LEDGER_STATUS.ERROR;
  return { periodId, status, closed };
}

/**
 * Сводка по набору: сколько месяцев ожидаем, сколько gap.
 * @param {string[]} expectedPeriodIds
 * @param {Map<string, object>|Record<string, object>} monthlyByPeriod
 */
function summarizeItemLedger(expectedPeriodIds, monthlyByPeriod) {
  const gaps = [];
  let closed = 0;
  for (const pid of expectedPeriodIds) {
    const doc =
      monthlyByPeriod instanceof Map ? monthlyByPeriod.get(pid) : monthlyByPeriod[pid];
    const slot = classifyPeriodSlot(pid, doc || null);
    if (slot.status === LEDGER_STATUS.GAP) gaps.push(pid);
    else if (slot.closed) closed += 1;
  }
  return {
    expected: expectedPeriodIds.length,
    closed,
    gaps,
    gapCount: gaps.length,
  };
}

module.exports = {
  parsePeriodId,
  formatPeriodId,
  utcYearMonth,
  lastClosedUtcYearMonth,
  closedUtcMonthsBack,
  addMonthsToPeriod,
  periodIdsBetween,
  expectedPeriodIdsForItem,
  classifyPeriodSlot,
  summarizeItemLedger,
};
