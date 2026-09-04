/**
 * Единый формат «месячной точки» рынка (любой источник).
 * Канон: BIF_parser.md § «Формат точки».
 *
 * sold — совершённые сделки (приоритет №1).
 * stock — выставленные лоты (приоритет №2, только если sold пуст).
 */
"use strict";

/**
 * Внимание: этот модуль — «сырьё» (публичный путь парсера). Формула оценки BIF
 * сюда не импортируется — расчёт new/used из точки вынесен в закрытую часть
 * (functions/), в публичный путь не попадает.
 */

/** Статус ячейки в ledger: набор × месяц закрыт или нет. */
const LEDGER_STATUS = Object.freeze({
  GAP: "gap",
  OK_SOLD: "ok_sold",
  OK_STOCK: "ok_stock",
  NO_DATA: "no_data",
  ERROR: "error",
  BOOTSTRAP: "bootstrap",
});

const SIDE_PAIRS = Object.freeze([
  { side: "new", soldKey: "soldNew", stockKey: "stockNew" },
  { side: "used", soldKey: "soldUsed", stockKey: "stockUsed" },
]);

function positiveUsdOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function aggregateHasSignal(agg) {
  if (!agg || typeof agg !== "object") return false;
  if (Number(agg.count) > 0 || Number(agg.totalQty) > 0) return true;
  return (
    positiveUsdOrNull(agg.avgUsd) != null ||
    positiveUsdOrNull(agg.medianUsd) != null ||
    positiveUsdOrNull(agg.qtyAvgUsd) != null
  );
}

/**
 * Приоритет №1 sold, №2 stock для одной стороны (new или used).
 * @returns {"sold"|"stock"|null}
 */
function resolveSideBasis(soldAgg, stockAgg) {
  if (aggregateHasSignal(soldAgg)) return "sold";
  if (aggregateHasSignal(stockAgg)) return "stock";
  return null;
}

/**
 * Ledger-статус по документу monthly / точке.
 * @param {{ status?: string, method?: string, errorTag?: string, soldNew?: object, soldUsed?: object, stockNew?: object, stockUsed?: object }} doc
 */
function ledgerStatusFromMonthly(doc) {
  if (!doc) return LEDGER_STATUS.GAP;
  const method = String(doc.method || doc.errorTag || "");
  if (method === "rrp_bootstrap_0_9") return LEDGER_STATUS.BOOTSTRAP;

  const st = String(doc.status || "");
  if (st === "error") return LEDGER_STATUS.ERROR;
  if (st === "no_data" || st === "pending") return LEDGER_STATUS.NO_DATA;

  let anySold = false;
  let anyStock = false;
  for (const { soldKey, stockKey } of SIDE_PAIRS) {
    const basis = resolveSideBasis(doc[soldKey], doc[stockKey]);
    if (basis === "sold") anySold = true;
    if (basis === "stock") anyStock = true;
  }
  if (anySold) return LEDGER_STATUS.OK_SOLD;
  if (anyStock) return LEDGER_STATUS.OK_STOCK;
  if (st === "ok") return LEDGER_STATUS.NO_DATA;
  return LEDGER_STATUS.GAP;
}

/**
 * @param {{
 *   catalogItemId: string,
 *   itemType?: string,
 *   periodId: string,
 *   source: string,
 *   method: string,
 *   scrapeStatus: "ok"|"no_data"|"error",
 *   empty?: boolean,
 *   soldNew?: object|null,
 *   soldUsed?: object|null,
 *   stockNew?: object|null,
 *   stockUsed?: object|null,
 *   errorTag?: string|null,
 *   setNo?: string|null,
 *   window?: string,
 *   extra?: object,
 * }} input
 */
function buildMonthlyMarketPoint(input) {
  const periodId = String(input.periodId || "");
  const [yearStr, monthStr] = periodId.split("-");
  const soldNew = input.soldNew || null;
  const soldUsed = input.soldUsed || null;
  const stockNew = input.stockNew || null;
  const stockUsed = input.stockUsed || null;

  let status = input.scrapeStatus || "error";
  if (status === "ok" && input.empty) status = "no_data";

  const sides = {};
  for (const { side, soldKey, stockKey } of SIDE_PAIRS) {
    const sold = input[soldKey];
    const stock = input[stockKey];
    const basis = resolveSideBasis(sold, stock);
    sides[side] = { basis, sold, stock };
  }

  const draft = {
    periodId,
    year: Number(yearStr),
    month: Number(monthStr),
    catalogItemId: String(input.catalogItemId),
    itemType: String(input.itemType || "SET").toUpperCase(),
    source: String(input.source || "unknown"),
    currency: "USD",
    method: String(input.method || ""),
    window: input.window || null,
    status,
    errorTag: input.errorTag || null,
    setNo: input.setNo || null,
    soldNew,
    soldUsed,
    stockNew,
    stockUsed,
    sides,
    ...(input.extra || {}),
  };

  draft.ledgerStatus = ledgerStatusFromMonthly(draft);
  return draft;
}

/** Документ для Firestore `market_observations/.../monthly/{periodId}`. */
function monthlyDocToFirestore(point, FieldValue) {
  const capturedAt = FieldValue ? FieldValue.serverTimestamp() : null;
  return {
    year: point.year,
    month: point.month,
    periodId: point.periodId,
    source: point.source,
    currency: point.currency || "USD",
    method: point.method,
    status: point.status,
    errorTag: point.errorTag || null,
    ledgerStatus: point.ledgerStatus,
    soldNew: point.soldNew,
    soldUsed: point.soldUsed,
    stockNew: point.stockNew,
    stockUsed: point.stockUsed,
    ...(point.new ? { new: point.new } : {}),
    ...(point.used ? { used: point.used } : {}),
    ...(point.rrpBootstrapUsd != null ? { rrpBootstrapUsd: point.rrpBootstrapUsd } : {}),
    ...(point.rrpUsdForBootstrap != null ? { rrpUsdForBootstrap: point.rrpUsdForBootstrap } : {}),
    capturedAt,
  };
}

/** Поля верхнего уровня observation (последний снимок источника). */
function observationDocFromPoint(point, FieldValue) {
  return {
    catalogItemId: point.catalogItemId,
    itemType: point.itemType,
    source: point.source,
    currency: point.currency || "USD",
    window: point.window || "last_6_months",
    method: point.method,
    status: point.status,
    empty: point.status === "no_data",
    soldNew: point.soldNew,
    soldUsed: point.soldUsed,
    stockNew: point.stockNew,
    stockUsed: point.stockUsed,
    setNo: point.setNo || null,
    error: point.status === "error" ? point.errorTag || "error" : null,
    errorTag: point.errorTag || null,
    ledgerStatus: point.ledgerStatus,
    capturedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Запись monthly + observation через общий формат (Firestore).
 * @returns {Promise<{ point: object, monthly: object, observation: object }>}
 */
async function writeMarketPoint(db, obsDocId, point, FieldValue, opts = {}) {
  const monthly = monthlyDocToFirestore(point, FieldValue);
  const observation = observationDocFromPoint(point, FieldValue);

  if (opts.dryRun) {
    return { dryRun: true, point, monthly, observation };
  }

  await db.collection("market_observations").doc(obsDocId).set(observation, { merge: true });
  await db
    .collection("market_observations")
    .doc(obsDocId)
    .collection("monthly")
    .doc(point.periodId)
    .set(monthly, { merge: true });

  return { dryRun: false, point, monthly, observation, wrote: true };
}

module.exports = {
  LEDGER_STATUS,
  SIDE_PAIRS,
  aggregateHasSignal,
  resolveSideBasis,
  ledgerStatusFromMonthly,
  buildMonthlyMarketPoint,
  monthlyDocToFirestore,
  observationDocFromPoint,
  writeMarketPoint,
};
