/**
 * Preview gap queue (no scrape). Requires Firebase credentials.
 *
 *   npm run ingest:bricklink:gap-queue
 *   npm run ingest:bricklink:gap-queue -- --limit=30 --types=SET
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { fetchGapQueue } = require("./gapQueue");
const { utcYearMonth } = require("./gapLedger");
const { normalizeSetNo } = require("./parseHtml");
const {
  isMistypedGearAsSet,
  normalizeItemNumber,
  BL_TYPE_PREFIX,
  resolveBrickLinkFetch,
} = require("./blUrls");

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return fallback;
}

function mapCatalogDoc(doc) {
  const d = doc.data() || {};
  const itemType = String(d.itemType || "SET").toUpperCase();
  const catalog = {
    itemType,
    itemNumber: d.itemNumber,
    themePrimary: d.themePrimary || d.theme || null,
    theme: d.theme || null,
    launchDateMs: d.launchDateMs ?? null,
    yearReleased: d.yearReleased ?? d.year ?? null,
  };
  const blFetch = resolveBrickLinkFetch(catalog);
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
  const { admin, db } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const limit = Math.max(1, Number(flagValue("limit", "25")) || 25);
  const types = String(flagValue("types", "SET,MINIFIG") || "SET,MINIFIG")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const tasks = await fetchGapQueue(db, admin, {
    types,
    maxTasks: limit,
    maxScan: limit * 30,
    currentPeriodId: periodId,
    mapCatalogDoc,
  });

  console.log(
    JSON.stringify(
      {
        step: "gap_queue_preview",
        periodId,
        count: tasks.length,
        tasks: tasks.map((t) => ({
          catalogItemId: t.cat.catalogItemId,
          itemNumber: t.cat.itemNumber,
          theme: t.cat.themePrimary || t.cat.theme,
          score: t.score,
          gapCount: t.gapCount,
          currentMonthGap: t.currentMonthGap,
          coverageReason: t.coverage?.reason,
          gapPeriods: t.gapPeriods,
        })),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
