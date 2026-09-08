/**
 * Сборка / пересборка месячных очередей съёма (market + Brick Owl).
 *
 *   npm run ingest:catalog:month-queue -- --confirm
 *   npm run ingest:catalog:month-queue -- --confirm --source=brickowl
 *   npm run ingest:catalog:month-queue -- --confirm --source=all
 *   npm run ingest:catalog:month-queue -- --dry-run
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { utcYearMonth, lastClosedUtcYearMonth } = require("./gapLedger");
const { buildMonthQueue, readMonthQueueMeta } = require("./monthQueue");
const { setCatalogPrimary } = require("./parserStats");
const { normalizeSetNo } = require("./parseHtml");
const {
  normalizeItemNumber,
  BL_TYPE_PREFIX,
  resolveMarketFetch,
  isMistypedGearAsSet,
} = require("./blUrls");
const { PRIMARY_TYPES } = require("./ingestTypes");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function mapCatalogDocBl(doc) {
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

function mapCatalogDocOwl(doc) {
  const d = doc.data() || {};
  const itemType = String(d.itemType || "SET").toUpperCase();
  return {
    catalogItemId: doc.id,
    itemType,
    itemNumber:
      normalizeSetNo(d.itemNumber) || String(d.itemNumber || "").trim() || null,
    themePrimary: d.themePrimary || d.theme || null,
    yearReleased: d.yearReleased ?? d.year ?? null,
    launchDateMs: d.launchDateMs ?? null,
    catalogSortLaunch: d.catalogSortLaunch ?? null,
  };
}

async function countCatalogPrimary(db, admin) {
  let total = 0;
  for (const itemType of PRIMARY_TYPES) {
    try {
      const snap = await db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .count()
        .get();
      total += Number(snap.data().count) || 0;
    } catch (e) {
      console.warn("catalog count failed", itemType, e && e.message ? e.message : e);
    }
  }
  return total;
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const periodId = flagValue("period", utcYearMonth());
  const dryRun = hasFlag("dry-run") || !hasFlag("confirm");
  const sourceRaw = String(flagValue("source", "all") || "all").toLowerCase();
  const types = String(flagValue("types", PRIMARY_TYPES.join(",")) || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const sources =
    sourceRaw === "all"
      ? ["bricklink", "brickowl"]
      : sourceRaw === "brickowl" || sourceRaw === "owl"
        ? ["brickowl"]
        : ["bricklink"];

  console.log(JSON.stringify({ step: "month_queue_build_start", periodId, dryRun, types, sources }));

  if (!dryRun) {
    const catalogPrimary = await countCatalogPrimary(db, admin);
    await setCatalogPrimary(db, admin.firestore, catalogPrimary, { periodId });
    console.log(JSON.stringify({ step: "catalog_primary_set", catalogPrimary }));
  }

  for (const source of sources) {
    const checkMonthId = source === "brickowl" ? lastClosedUtcYearMonth() : periodId;
    const mapCatalogDoc = source === "brickowl" ? mapCatalogDocOwl : mapCatalogDocBl;
    const r = await buildMonthQueue(db, admin, {
      periodId,
      source,
      checkMonthId,
      types,
      mapCatalogDoc,
      FieldValue,
      dryRun,
    });
    const meta = dryRun ? null : await readMonthQueueMeta(db, periodId, source);
    console.log(
      JSON.stringify({
        step: "month_queue_build_done",
        source,
        checkMonthId,
        ...r,
        metaStatus: meta?.status || null,
      })
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
