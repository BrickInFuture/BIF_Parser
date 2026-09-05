/**
 * СЫРОЙ путь (публичный): запись рыночных точек market в Firestore
 * БЕЗ расчёта оценки BIF.
 *
 * Пишет только:
 *   market_observations/{id}__market                    — последний снимок
 *   market_observations/{id}__market/monthly/{YYYY-MM}  — помесячно sold/stock
 *
 * Оценку BIF считает закрытая часть (functions/bifFromObservation.js):
 *   • в приватном/локальном прогоне — inline после этой записи (см. observationWriter.js);
 *   • в публичном прогоне (BL_RAW_ONLY=1) — Firestore-триггер onMarketMonthlyWritten.
 *
 * Секретных импортов здесь нет — файл можно выкладывать в публичный репозиторий.
 */
"use strict";

const { observationDocId } = require("./catalogFields");
const {
  buildMonthlyMarketPoint,
  writeMarketPoint,
  aggregateHasSignal,
  observationDocFromPoint,
} = require("./marketPoint");
const {
  utcYearMonth,
  lastClosedUtcYearMonth,
  addMonthsToPeriod,
} = require("./gapLedger");
const { RRP_BOOTSTRAP_METHOD } = require("./coveragePolicy");

/** Месяц смотрели на BL, сделок нет — закрываем ledger, не крутим в gap-очереди. */
const BL_MONTH_ABSENT_TAG = "bl_month_absent";

function rowHasSoldSignal(row) {
  if (!row) return false;
  return aggregateHasSignal(row.soldNew) || aggregateHasSignal(row.soldUsed);
}

/**
 * Дыры между самым ранним месяцем на странице и текущим UTC → no_data.
 * (На BL месяца не было / пустой блок — повторно искать бессмысленно.)
 */
function sealAbsentMonthsBetween(points, currentPeriodId, baseMeta) {
  const byId = new Map();
  for (const p of points) {
    if (p && p.periodId) byId.set(String(p.periodId), p);
  }
  const ids = [...byId.keys()].sort();
  if (!ids.length) return points;

  const fromPid = ids[0];
  let pid = fromPid;
  while (pid && pid <= currentPeriodId) {
    // Текущий UTC-месяц не запечатываем тут — ниже, с витриной (stock).
    if (!byId.has(pid) && pid !== currentPeriodId) {
      const sealed = buildMonthlyMarketPoint({
        catalogItemId: baseMeta.catalogItemId,
        itemType: baseMeta.itemType,
        periodId: pid,
        source: "bricklink",
        method: baseMeta.method,
        scrapeStatus: "no_data",
        empty: true,
        setNo: baseMeta.setNo || null,
        window: "calendar_month",
        errorTag: BL_MONTH_ABSENT_TAG,
      });
      byId.set(pid, sealed);
    }
    if (pid === currentPeriodId) break;
    const next = addMonthsToPeriod(pid, 1);
    if (!next || next <= pid) break;
    pid = next;
  }

  if (!byId.has(currentPeriodId)) {
    const hasStock =
      aggregateHasSignal(baseMeta.stockNew) || aggregateHasSignal(baseMeta.stockUsed);
    byId.set(
      currentPeriodId,
      buildMonthlyMarketPoint({
        catalogItemId: baseMeta.catalogItemId,
        itemType: baseMeta.itemType,
        periodId: currentPeriodId,
        source: "bricklink",
        method: baseMeta.method,
        scrapeStatus: hasStock ? "ok" : "no_data",
        empty: !hasStock,
        stockNew: hasStock ? baseMeta.stockNew || null : null,
        stockUsed: hasStock ? baseMeta.stockUsed || null : null,
        setNo: baseMeta.setNo || null,
        window: "calendar_month",
        errorTag: hasStock ? null : BL_MONTH_ABSENT_TAG,
      })
    );
  }

  return [...byId.values()].sort((a, b) => a.periodId.localeCompare(b.periodId));
}

/** Одна сырая точка (ошибка / пустой рынок / без помесячной детализации). */
async function writeRawSingle(db, adminFirestore, payload, opts, periodId) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId);
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const parsed = payload.parsed || {};
  const obsId = observationDocId(catalogItemId, "bricklink");
  const method = payload.method || "http_token_catalogPG";

  const point = buildMonthlyMarketPoint({
    catalogItemId,
    itemType,
    periodId,
    source: "bricklink",
    method,
    scrapeStatus: parsed.ok ? (parsed.empty ? "no_data" : "ok") : "error",
    empty: !!parsed.empty,
    soldNew: parsed.soldNew || null,
    soldUsed: parsed.soldUsed || null,
    stockNew: parsed.stockNew || null,
    stockUsed: parsed.stockUsed || null,
    setNo: payload.setNo || null,
    window: parsed.empty ? "no_data" : "calendar_month",
    errorTag: parsed.ok
      ? parsed.empty
        ? payload.errorTag || null
        : null
      : payload.errorTag || null,
  });

  const packed = await writeMarketPoint(db, obsId, point, FieldValue, { dryRun: true });
  const observation = {
    ...packed.observation,
    error: parsed.ok ? null : parsed.error || null,
  };

  if (opts.dryRun) {
    return {
      dryRun: true,
      obsId,
      periodId,
      bifPeriodId: lastClosedUtcYearMonth(),
      writtenPeriodIds: [periodId],
      observation,
      monthly: packed.monthly,
    };
  }

  await writeMarketPoint(db, obsId, point, FieldValue, { dryRun: false });
  if (!parsed.ok && parsed.error) {
    await db.collection("market_observations").doc(obsId).set({ error: parsed.error }, { merge: true });
  }

  return {
    dryRun: false,
    obsId,
    periodId,
    bifPeriodId: lastClosedUtcYearMonth(),
    writtenPeriodIds: [periodId],
    wroteObservation: true,
  };
}

/**
 * Запись сырых точек из результата скрейпа.
 * Мультимесяц: все помесячные sold-блоки со страницы Price Guide.
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} adminFirestore admin.firestore (для FieldValue)
 * @param {{ catalogItemId: string, itemType?: string, setNo?: string, parsed: object, method?: string, errorTag?: string }} payload
 * @param {{ dryRun?: boolean }} [opts]
 */
async function writeRawObservationFromParse(db, adminFirestore, payload, opts = {}) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId);
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const parsed = payload.parsed || {};
  const obsId = observationDocId(catalogItemId, "bricklink");
  const currentPeriodId = utcYearMonth();
  const method = payload.method || "http_token_catalogPG";
  const monthlySold = Array.isArray(parsed.monthlySold) ? parsed.monthlySold : null;

  if (!parsed.ok || parsed.empty || !monthlySold || monthlySold.length === 0) {
    return writeRawSingle(db, adminFirestore, payload, opts, currentPeriodId);
  }

  const rows = [...monthlySold].sort((a, b) => a.periodId.localeCompare(b.periodId));
  let points = rows.map((row) => {
    const attachStock = row.periodId === currentPeriodId && !rowHasSoldSignal(row);
    return buildMonthlyMarketPoint({
      catalogItemId,
      itemType,
      periodId: row.periodId,
      source: "bricklink",
      method,
      scrapeStatus: row.empty ? "no_data" : "ok",
      empty: !!row.empty,
      soldNew: row.soldNew || null,
      soldUsed: row.soldUsed || null,
      stockNew: attachStock ? parsed.stockNew || null : null,
      stockUsed: attachStock ? parsed.stockUsed || null : null,
      setNo: payload.setNo || null,
      window: "calendar_month",
      errorTag: row.empty ? BL_MONTH_ABSENT_TAG : null,
    });
  });

  points = sealAbsentMonthsBetween(points, currentPeriodId, {
    catalogItemId,
    itemType,
    method,
    setNo: payload.setNo || null,
    stockNew: parsed.stockNew || null,
    stockUsed: parsed.stockUsed || null,
  });

  const bifPeriodId = lastClosedUtcYearMonth();
  const snapshotPoint =
    points.find((p) => p.periodId === currentPeriodId) || points[points.length - 1];
  // Parent snapshot is what GET /catalog uses for the on-read card price.
  // Monthly rows only carry stock when the *current* month has no sold — so a
  // Used-only closed month would leave New blank on the card. Always mirror the
  // Price Guide summary sold+stock onto the parent doc (6-month / live listings).
  const observation = {
    ...observationDocFromPoint(snapshotPoint, FieldValue),
    soldNew: parsed.soldNew || null,
    soldUsed: parsed.soldUsed || null,
    stockNew: parsed.stockNew || null,
    stockUsed: parsed.stockUsed || null,
    error: null,
  };

  if (opts.dryRun) {
    const lastPacked = await writeMarketPoint(db, obsId, snapshotPoint, FieldValue, { dryRun: true });
    return {
      dryRun: true,
      obsId,
      periodId: snapshotPoint.periodId,
      bifPeriodId,
      writtenPeriodIds: points.map((p) => p.periodId),
      observation,
      monthly: lastPacked.monthly,
    };
  }

  for (const point of points) {
    await db
      .collection("market_observations")
      .doc(obsId)
      .collection("monthly")
      .doc(point.periodId)
      .set(
        {
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
          capturedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }
  await db.collection("market_observations").doc(obsId).set(observation, { merge: true });

  return {
    dryRun: false,
    obsId,
    periodId: snapshotPoint.periodId,
    bifPeriodId,
    writtenPeriodIds: points.map((p) => p.periodId),
    wroteObservation: true,
  };
}

/**
 * Нет вторичного рынка у новинки → сырой маркер месяца (method=rrp_bootstrap_0_9)
 * с сохранённым rrpUsdForBootstrap. Оценку RRP×0.9 считает закрытая часть.
 * @param {{ catalogItemId: string, itemType?: string, setNo?: string|null, rrpUsd: number, launchDateMs?: number|null }} payload
 */
async function writeRawBootstrapMarker(db, adminFirestore, payload, opts = {}) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId);
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const rrpUsd = Number(payload.rrpUsd);
  if (!Number.isFinite(rrpUsd) || rrpUsd <= 0) {
    return { dryRun: !!opts.dryRun, wrote: false, reason: "no_rrp" };
  }

  const obsId = observationDocId(catalogItemId, "bricklink");
  const periodId = utcYearMonth();

  const point = buildMonthlyMarketPoint({
    catalogItemId,
    itemType,
    periodId,
    source: "bricklink",
    method: RRP_BOOTSTRAP_METHOD,
    scrapeStatus: "no_data",
    empty: true,
    setNo: payload.setNo || null,
    window: "bootstrap",
    errorTag: RRP_BOOTSTRAP_METHOD,
    extra: { rrpUsdForBootstrap: rrpUsd },
  });

  const packed = await writeMarketPoint(db, obsId, point, FieldValue, { dryRun: true });
  if (opts.dryRun) {
    return { dryRun: true, wrote: true, obsId, periodId, observation: packed.observation, monthly: packed.monthly };
  }

  await writeMarketPoint(db, obsId, point, FieldValue, { dryRun: false });
  return { dryRun: false, wrote: true, obsId, periodId };
}

module.exports = {
  BL_MONTH_ABSENT_TAG,
  rowHasSoldSignal,
  sealAbsentMonthsBetween,
  writeRawSingle,
  writeRawObservationFromParse,
  writeRawBootstrapMarker,
};
