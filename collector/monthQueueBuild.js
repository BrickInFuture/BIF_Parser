/**
 * Сборка / пересборка месячной очереди съёма.
 *
 *   npm run ingest:catalog:month-queue -- --confirm
 *   npm run ingest:catalog:month-queue -- --confirm --rebuild
 *   npm run ingest:catalog:month-queue -- --dry-run
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { utcYearMonth } = require("./gapLedger");
const { buildMonthQueue, readMonthQueueMeta } = require("./monthQueue");
const { normalizeSetNo } = require("./parseHtml");
const { normalizeItemNumber, BL_TYPE_PREFIX, resolveMarketFetch, isMistypedGearAsSet } = require("./blUrls");
const { PRIMARY_TYPES } = require("./ingestTypes");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function mapCatalogDoc(doc) {
  const d = doc.data() || {};
  const itemType = String(d.itemType || "SET").toUpperCase();
  const catalog = {
    itemType,
    itemNumber: d.itemNumber,
    themePrimary: d.themePrimary || d.theme || null,
    theme: d.theme || null,
    itemName: d.itemName || null,
    brickLinkItemType: d.brickLinkItemType || null,
    brickLinkNo: d.brickLinkNo || null,
    pieceCount: d.pieceCount ?? d.pieces ?? null,
    rrpUsd: d.rrpUsd ?? d.USRetailPrice ?? null,
    launchDateMs: d.launchDateMs ?? null,
    launchDate: d.launchDate ?? null,
    yearReleased: d.yearReleased ?? d.year ?? null,
  };
  const blFetch = resolveMarketFetch(catalog);
  const fetchType = blFetch.skip ? itemType : blFetch.itemType || itemType;
  return {
    catalogItemId: doc.id,
    ...catalog,
    itemNumber:
      normalizeItemNumber(d.itemNumber, itemType) ||
      normalizeSetNo(d.itemNumber) ||
      String(d.itemNumber || "").trim(),
    mistypedGear: isMistypedGearAsSet(d),
    supportedBlType: Boolean(BL_TYPE_PREFIX[fetchType]),
    blFetch,
  };
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const periodId = flagValue("period", utcYearMonth());
  const dryRun = hasFlag("dry-run") || !hasFlag("confirm");
  const types = String(flagValue("types", PRIMARY_TYPES.join(",")) || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  console.log(JSON.stringify({ step: "month_queue_build_start", periodId, dryRun, types }));
  const r = await buildMonthQueue(db, admin, {
    periodId,
    types,
    mapCatalogDoc,
    FieldValue,
    dryRun,
  });
  const meta = dryRun ? null : await readMonthQueueMeta(db, periodId);
  console.log(JSON.stringify({ step: "month_queue_build_done", ...r, metaStatus: meta?.status || null }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
