/**
 * РЎР«Р РћР™ РїСѓС‚СЊ (РїСѓР±Р»РёС‡РЅС‹Р№): Р·Р°РїРёСЃСЊ СЂС‹РЅРѕС‡РЅС‹С… С‚РѕС‡РµРє market РІ Firestore
 * Р‘Р•Р— СЂР°СЃС‡С‘С‚Р° РѕС†РµРЅРєРё BIF.
 *
 * РџРёС€РµС‚ С‚РѕР»СЊРєРѕ:
 *   market_observations/{id}__market                    вЂ” РїРѕСЃР»РµРґРЅРёР№ СЃРЅРёРјРѕРє
 *   market_observations/{id}__market/monthly/{YYYY-MM}  вЂ” РїРѕРјРµСЃСЏС‡РЅРѕ sold/stock
 *
 * РћС†РµРЅРєСѓ BIF СЃС‡РёС‚Р°РµС‚ Р·Р°РєСЂС‹С‚Р°СЏ С‡Р°СЃС‚СЊ (functions/bifFromObservation.js):
 *   вЂў РІ РїСЂРёРІР°С‚РЅРѕРј/Р»РѕРєР°Р»СЊРЅРѕРј РїСЂРѕРіРѕРЅРµ вЂ” inline РїРѕСЃР»Рµ СЌС‚РѕР№ Р·Р°РїРёСЃРё (СЃРј. observationWriter.js);
 *   вЂў РІ РїСѓР±Р»РёС‡РЅРѕРј РїСЂРѕРіРѕРЅРµ (BL_RAW_ONLY=1) вЂ” Firestore-С‚СЂРёРіРіРµСЂ onMarketMonthlyWritten.
 *
 * РЎРµРєСЂРµС‚РЅС‹С… РёРјРїРѕСЂС‚РѕРІ Р·РґРµСЃСЊ РЅРµС‚ вЂ” С„Р°Р№Р» РјРѕР¶РЅРѕ РІС‹РєР»Р°РґС‹РІР°С‚СЊ РІ РїСѓР±Р»РёС‡РЅС‹Р№ СЂРµРїРѕР·РёС‚РѕСЂРёР№.
 */
"use strict";

const { observationDocId } = require("./catalogFields");
const {
  buildMonthlyMarketPoint,
  writeMarketPoint,
  aggregateHasSignal,
  observationDocFromPoint,
} = require("./marketPoint");
const { utcYearMonth, lastClosedUtcYearMonth } = require("./gapLedger");
const { RRP_BOOTSTRAP_METHOD } = require("./coveragePolicy");

function rowHasSoldSignal(row) {
  if (!row) return false;
  return aggregateHasSignal(row.soldNew) || aggregateHasSignal(row.soldUsed);
}

/** РћРґРЅР° СЃС‹СЂР°СЏ С‚РѕС‡РєР° (РѕС€РёР±РєР° / РїСѓСЃС‚РѕР№ СЂС‹РЅРѕРє / Р±РµР· РїРѕРјРµСЃСЏС‡РЅРѕР№ РґРµС‚Р°Р»РёР·Р°С†РёРё). */
async function writeRawSingle(db, adminFirestore, payload, opts, periodId) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId);
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const parsed = payload.parsed || {};
  const obsId = observationDocId(catalogItemId, "market");
  const method = payload.method || "http_token_catalogPG";

  const point = buildMonthlyMarketPoint({
    catalogItemId,
    itemType,
    periodId,
    source: "market",
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
 * Р—Р°РїРёСЃСЊ СЃС‹СЂС‹С… С‚РѕС‡РµРє РёР· СЂРµР·СѓР»СЊС‚Р°С‚Р° СЃРєСЂРµР№РїР°.
 * РњСѓР»СЊС‚РёРјРµСЃСЏС†: РІСЃРµ РїРѕРјРµСЃСЏС‡РЅС‹Рµ sold-Р±Р»РѕРєРё СЃРѕ СЃС‚СЂР°РЅРёС†С‹ Price Guide.
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} adminFirestore admin.firestore (РґР»СЏ FieldValue)
 * @param {{ catalogItemId: string, itemType?: string, setNo?: string, parsed: object, method?: string, errorTag?: string }} payload
 * @param {{ dryRun?: boolean }} [opts]
 */
async function writeRawObservationFromParse(db, adminFirestore, payload, opts = {}) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId);
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const parsed = payload.parsed || {};
  const obsId = observationDocId(catalogItemId, "market");
  const currentPeriodId = utcYearMonth();
  const method = payload.method || "http_token_catalogPG";
  const monthlySold = Array.isArray(parsed.monthlySold) ? parsed.monthlySold : null;

  if (!parsed.ok || parsed.empty || !monthlySold || monthlySold.length === 0) {
    return writeRawSingle(db, adminFirestore, payload, opts, currentPeriodId);
  }

  const rows = [...monthlySold].sort((a, b) => a.periodId.localeCompare(b.periodId));
  const points = rows.map((row) => {
    const attachStock = row.periodId === currentPeriodId && !rowHasSoldSignal(row);
    return buildMonthlyMarketPoint({
      catalogItemId,
      itemType,
      periodId: row.periodId,
      source: "market",
      method,
      scrapeStatus: row.empty ? "no_data" : "ok",
      empty: !!row.empty,
      soldNew: row.soldNew || null,
      soldUsed: row.soldUsed || null,
      stockNew: attachStock ? parsed.stockNew || null : null,
      stockUsed: attachStock ? parsed.stockUsed || null : null,
      setNo: payload.setNo || null,
      window: "calendar_month",
      errorTag: null,
    });
  });

  const bifPeriodId = lastClosedUtcYearMonth();
  const snapshotPoint =
    points.find((p) => p.periodId === currentPeriodId) || points[points.length - 1];
  // Parent snapshot is what GET /catalog uses for on-read estimateSide.
  // Monthly rows only carry stock when the *current* month has no sold вЂ” so a
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
 * РќРµС‚ РІС‚РѕСЂРёС‡РЅРѕРіРѕ СЂС‹РЅРєР° Сѓ РЅРѕРІРёРЅРєРё в†’ СЃС‹СЂРѕР№ РјР°СЂРєРµСЂ РјРµСЃСЏС†Р° (method=rrp_bootstrap_0_9)
 * СЃ СЃРѕС…СЂР°РЅС‘РЅРЅС‹Рј rrpUsdForBootstrap. РћС†РµРЅРєСѓ RRPГ—0.9 СЃС‡РёС‚Р°РµС‚ Р·Р°РєСЂС‹С‚Р°СЏ С‡Р°СЃС‚СЊ.
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

  const obsId = observationDocId(catalogItemId, "market");
  const periodId = utcYearMonth();

  const point = buildMonthlyMarketPoint({
    catalogItemId,
    itemType,
    periodId,
    source: "market",
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
  rowHasSoldSignal,
  writeRawSingle,
  writeRawObservationFromParse,
  writeRawBootstrapMarker,
};

