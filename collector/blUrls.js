/**
 * Catalog URL helpers (market adapter).
 *
 * Канон Price Guide для BIF: ТОЛЬКО «View older version» =
 *   https://www.market.com/catalogPG.asp?S=75192-1&vcID=1
 * (ссылка с новой v2-карточки «View older version» ведёт сюда).
 * Новую вкладку v2/catalog/catalogitem.page#T=P НЕ используем —
 * там нет полной помесячной истории в одном HTML.
 *
 *   vcID=1 — Viewing Currency = USD (иначе BL отдаёт валюту по IP/кукам).
 *   SET  → S=75192-1
 *   GEAR → G=100871
 *   MINIFIG → M=...
 */
"use strict";

const { resolveSourceLookup } = require("./catalogFields");

/** market Viewing Currency: 1 = USD */
const BL_VIEWING_CURRENCY_USD = 1;

const BL_TYPE_PREFIX = {
  SET: "S",
  MINIFIG: "M",
  PART: "P",
  GEAR: "G",
  BOOK: "B",
  CATALOG: "C",
  INSTRUCTION: "I",
  INST: "I",
  ORIGINAL_BOX: "O",
  BOX: "O",
};

/**
 * Normalize item number for a BIF itemType.
 * SET keeps/adds -N variant; GEAR/MINIFIG/etc keep bare id (strip trailing -1 if present for GEAR).
 */
function normalizeItemNumber(raw, itemType = "SET") {
  const s = String(raw || "").trim();
  if (!s) return null;
  const t = String(itemType || "SET").toUpperCase();
  if (t === "SET") {
    return s.includes("-") ? s : `${s}-1`;
  }
  if (t === "GEAR") {
    // Prefer bare BL gear number (100871 not 100871-1)
    return s.replace(/-1$/i, "");
  }
  return s;
}

/** Classic Price Guide = «View older version» (full monthly sold history). */
function marketCatalogPgUrl(itemType, itemNumber) {
  const t = String(itemType || "SET").toUpperCase();
  const prefix = BL_TYPE_PREFIX[t] || "S";
  const no = normalizeItemNumber(itemNumber, t);
  if (!no) throw new Error("itemNumber is required");
  return `https://www.bricklink.com/catalogPG.asp?${prefix}=${encodeURIComponent(no)}&vcID=${BL_VIEWING_CURRENCY_USD}`;
}

/** Alias: same URL — explicit name for «View older version only». */
function olderPriceGuideUrl(itemType, itemNumber) {
  return marketCatalogPgUrl(itemType, itemNumber);
}

/**
 * Number/type to open for a catalog_items doc.
 * Uses stored brickLinkNo when present; skips CMF rows with no BL listing.
 */
function resolveMarketFetch(catalog = {}) {
  const lookup = resolveSourceLookup(catalog);
  if (lookup.skip) {
    return { skip: true, reason: lookup.reason || "skip_no_bl_item" };
  }
  if (lookup.itemType && lookup.itemNumber) {
    const itemType = String(lookup.itemType).toUpperCase();
    const itemNumber = normalizeItemNumber(lookup.itemNumber, itemType) || String(lookup.itemNumber).trim();
    return { skip: false, itemType, itemNumber };
  }
  const itemType = String(catalog.itemType || "SET").toUpperCase();
  const itemNumber =
    normalizeItemNumber(catalog.itemNumber, itemType) || String(catalog.itemNumber || "").trim();
  if (!itemNumber) return { skip: true, reason: "missing_itemNumber" };
  return { skip: false, itemType, itemNumber };
}

/** True if catalog row looks like Gear mistyped as SET (Brickset import bug). */
function isMistypedGearAsSet(catalog = {}) {
  const type = String(catalog.itemType || "").toUpperCase();
  if (type && type !== "SET") return false;
  const theme = String(catalog.themePrimary || catalog.theme || "").trim().toLowerCase();
  const cat = String(catalog.bricksetCategory || "").trim().toLowerCase();
  if (theme === "gear" || theme.startsWith("gear ")) return true;
  if (cat === "gear") return true;
  return false;
}

/**
 * Catalog rows marked to stay out of primary price ingest (e.g. bulk BL minifig skeleton).
 * On-demand single refresh may still use them later; monthly queue skips.
 */
function isPriceIngestExcluded(catalog = {}) {
  return catalog.priceIngestExclude === true;
}

/** Skip reasons shared by catalog/gap/month queues. */
function shouldSkipCatalogIngest(cat = {}) {
  if (!cat || !cat.itemNumber) return true;
  if (!cat.supportedBlType) return true;
  if (cat.mistypedGear) return true;
  if (cat.priceIngestExclude) return true;
  return false;
}

module.exports = {
  BL_TYPE_PREFIX,
  BL_VIEWING_CURRENCY_USD,
  normalizeItemNumber,
  marketCatalogPgUrl,
  olderPriceGuideUrl,
  isMistypedGearAsSet,
  isPriceIngestExcluded,
  shouldSkipCatalogIngest,
  resolveMarketFetch,
};
