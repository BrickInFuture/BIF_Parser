/**
 * BrickLink catalog URL helpers (source adapter).
 * BIF itemType → BrickLink catalogPG query param.
 *
 *   SET  → S=75192-1
 *   GEAR → G=100871   (no -1 variant by convention)
 *   MINIFIG → M=...
 *
 * CMF figures keep Brickset numbers in catalog_items (MINIFIG_71051-1) but
 * must be fetched as M=col461 via brickLinkNo — see resolveBrickLinkFetch().
 */
"use strict";

const { effectiveBrickLinkLookup } = require("./catalogFields");

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

function brickLinkCatalogPgUrl(itemType, itemNumber) {
  const t = String(itemType || "SET").toUpperCase();
  const prefix = BL_TYPE_PREFIX[t] || "S";
  const no = normalizeItemNumber(itemNumber, t);
  if (!no) throw new Error("itemNumber is required");
  return `https://www.bricklink.com/catalogPG.asp?${prefix}=${encodeURIComponent(no)}`;
}

/**
 * Number/type to actually open on BrickLink for a catalog_items doc.
 * Uses stored brickLinkNo when present; skips CMF rows with no BL listing.
 */
function resolveBrickLinkFetch(catalog = {}) {
  const lookup = effectiveBrickLinkLookup(catalog);
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

module.exports = {
  BL_TYPE_PREFIX,
  normalizeItemNumber,
  brickLinkCatalogPgUrl,
  isMistypedGearAsSet,
  resolveBrickLinkFetch,
};
