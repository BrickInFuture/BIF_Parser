/**
 * Сырьё Brick Owl → market_observations/{id}__brickowl/monthly/{lastClosed}.
 * 6 Months New/Used пишем как sold за последний закрытый UTC-месяц (решение владельца).
 */
"use strict";

const { observationDocId } = require("../catalogFields");
const {
  buildMonthlyMarketPoint,
  writeMarketPoint,
  observationDocFromPoint,
  aggregateHasSignal,
} = require("../marketPoint");
const { lastClosedUtcYearMonth } = require("../gapLedger");

const SOURCE = "brickowl";

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} adminFirestore
 * @param {{
 *   catalogItemId: string,
 *   itemType?: string,
 *   setNo?: string|null,
 *   soldNew?: object|null,
 *   soldUsed?: object|null,
 *   empty?: boolean,
 *   method?: string,
 *   errorTag?: string|null,
 *   boid?: string|null,
 *   owlItemId?: string|null,
 *   currencyHint?: string|null,
 *   periodId?: string|null,
 *   nowDate?: Date,
 * }} payload
 * @param {{ dryRun?: boolean }} [opts]
 */
async function writeRawBrickOwlSixMonthAsLastClosed(db, adminFirestore, payload, opts = {}) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId || "");
  if (!catalogItemId) return { wrote: false, reason: "no_id" };

  const now = payload.nowDate instanceof Date ? payload.nowDate : new Date();
  const periodId = String(payload.periodId || lastClosedUtcYearMonth(now));
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const method = String(payload.method || "html_price_history_6m");
  const soldNew = payload.soldNew || null;
  const soldUsed = payload.soldUsed || null;
  const hasSold = aggregateHasSignal(soldNew) || aggregateHasSignal(soldUsed);
  const empty = payload.empty === true || !hasSold;

  const point = buildMonthlyMarketPoint({
    catalogItemId,
    itemType,
    periodId,
    source: SOURCE,
    method,
    scrapeStatus: empty ? "no_data" : "ok",
    empty,
    soldNew: empty ? null : soldNew,
    soldUsed: empty ? null : soldUsed,
    stockNew: null,
    stockUsed: null,
    setNo: payload.setNo || null,
    window: "owl_6m_as_last_closed",
    errorTag: payload.errorTag || null,
    extra: {
      owlWindow: "6m",
      boid: payload.boid || null,
      currencyHint: payload.currencyHint || null,
    },
  });

  // Persist owl meta on monthly doc via observationDocFromPoint / writeMarketPoint —
  // monthlyDocToFirestore doesn't include extra; stash on parent + method/window fields.
  const obsId = observationDocId(catalogItemId, SOURCE);
  const packed = await writeMarketPoint(db, obsId, point, FieldValue, { dryRun: !!opts.dryRun });

  if (!opts.dryRun) {
    const parent = observationDocFromPoint(point, FieldValue);
    parent.boid = payload.boid || null;
    parent.owlItemId = payload.owlItemId || null;
    parent.owlWindow = "6m";
    parent.currencyHint = payload.currencyHint || null;
    parent.source = SOURCE;
    await db.collection("market_observations").doc(obsId).set(parent, { merge: true });

    // Annotate monthly with owlWindow/boid (merge).
    await db
      .collection("market_observations")
      .doc(obsId)
      .collection("monthly")
      .doc(periodId)
      .set(
        {
          owlWindow: "6m",
          boid: payload.boid || null,
          owlItemId: payload.owlItemId || null,
          currencyHint: payload.currencyHint || null,
        },
        { merge: true }
      );
  }

  return {
    wrote: !opts.dryRun,
    dryRun: !!opts.dryRun,
    obsId,
    periodId,
    source: SOURCE,
    status: point.status,
    packed,
    point,
  };
}

/**
 * Ошибка съёма → monthly lastClosed + корень status=error (чтобы попасть в повтор).
 * no_data сюда не пишем.
 */
async function writeRawBrickOwlError(db, adminFirestore, payload, opts = {}) {
  const FieldValue = adminFirestore.FieldValue;
  const catalogItemId = String(payload.catalogItemId || "");
  if (!catalogItemId) return { wrote: false, reason: "no_id" };

  const now = payload.nowDate instanceof Date ? payload.nowDate : new Date();
  const periodId = String(payload.periodId || lastClosedUtcYearMonth(now));
  const itemType = String(payload.itemType || "SET").toUpperCase();
  const errorTag = String(payload.errorTag || "bo_error");

  const point = buildMonthlyMarketPoint({
    catalogItemId,
    itemType,
    periodId,
    source: SOURCE,
    method: String(payload.method || "ajax_price_history_6m"),
    scrapeStatus: "error",
    empty: true,
    soldNew: null,
    soldUsed: null,
    stockNew: null,
    stockUsed: null,
    setNo: payload.setNo || null,
    window: "owl_6m_as_last_closed",
    errorTag,
    extra: {
      owlWindow: "6m",
      boid: payload.boid || null,
    },
  });

  const obsId = observationDocId(catalogItemId, SOURCE);
  const packed = await writeMarketPoint(db, obsId, point, FieldValue, { dryRun: !!opts.dryRun });

  if (!opts.dryRun) {
    const parent = observationDocFromPoint(point, FieldValue);
    parent.boid = payload.boid || null;
    parent.owlItemId = payload.owlItemId || null;
    parent.owlWindow = "6m";
    parent.source = SOURCE;
    await db.collection("market_observations").doc(obsId).set(parent, { merge: true });
  }

  return {
    wrote: !opts.dryRun,
    dryRun: !!opts.dryRun,
    obsId,
    periodId,
    source: SOURCE,
    status: "error",
    packed,
    point,
  };
}

module.exports = {
  SOURCE,
  writeRawBrickOwlSixMonthAsLastClosed,
  writeRawBrickOwlError,
};
