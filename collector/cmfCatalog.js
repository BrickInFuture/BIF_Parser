/**
 * Collectable Minifigures (CMF): BIF type vs source lookup.
 *
 * Public catalog id stays Brickset Number-Variant (MINIFIG_71051-1 / SET_71051-0).
 * Parsers must use brickLinkItemType + brickLinkNo (M=col461, S=71051-1), never
 * S=71051-1 for an individual figure (that page is the polybag, not the character).
 */
"use strict";

const CMF_THEME_RE = /^collect(?:able|ible)\s+minifigures\b/i;
const CMF_THEME_PRIMARY_NAMES = ["Collectable Minifigures", "Collectible Minifigures"];
const PACK_NAME_RE =
  /random\s*pack|random\s*bags?|\{\s*box of\b|\bbox of\s+\d|sealed box|\bcomplete\b|minifigures?\s+pack\b|minifigure pack\b|minifigures?\s+collection\b|accessory (?:set|pack)\b|boxed minifigures|\bpack\b/i;

function pickTheme(src = {}) {
  return String(src.themePrimary || src.Theme || src.theme || src.catalogTheme || "").trim();
}

function isCmfTheme(src = {}) {
  if (!src || typeof src !== "object") return false;
  const pri = pickTheme(src);
  if (pri && CMF_THEME_RE.test(pri)) return true;
  const theme = String(src.theme || "").trim();
  return Boolean(theme && CMF_THEME_RE.test(theme));
}

function isCmfThemePrimary(name) {
  return CMF_THEME_RE.test(String(name || "").trim());
}

/** Орфографии тем для запросов по themePrimary. */
function cmfThemePrimaryQueryNames(hint = "") {
  if (!isCmfThemePrimary(hint)) {
    const one = String(hint || "").trim();
    return one ? [one] : [];
  }
  return [...CMF_THEME_PRIMARY_NAMES];
}

function normalizeSetType(src = {}) {
  return String(src.bricksetSetType || src.SetType || "").trim();
}

function itemNameOf(src = {}) {
  return String(src.itemName || src.SetName || src.setName || "").trim();
}

function itemNumberOf(src = {}) {
  const direct = String(src.itemNumber || src.setNumber || "").trim();
  if (direct) return direct;
  const n = String(src.Number ?? "").trim();
  if (!n) return "";
  const v = src.Variant != null && String(src.Variant).trim() !== "" ? String(src.Variant).trim() : "";
  return v ? `${n}-${v}` : n;
}

function parseVariantSuffix(itemNumber) {
  const s = String(itemNumber || "").trim();
  const m = s.match(/^(.*)-(\d+)$/);
  if (!m) return { base: s, variant: null };
  return { base: m[1], variant: Number(m[2]) };
}

function isCmfPackOrCollection(src = {}) {
  if (!isCmfTheme(src)) return false;
  const setType = normalizeSetType(src).toLowerCase();
  if (setType === "random" || setType === "collection") return true;
  if (PACK_NAME_RE.test(itemNameOf(src))) return true;
  const { variant } = parseVariantSuffix(itemNumberOf(src));
  return variant === 0;
}

function isCmfFigure(src = {}) {
  if (!isCmfTheme(src)) return false;
  if (isCmfPackOrCollection(src)) return false;
  const setType = normalizeSetType(src).toLowerCase();
  if (setType === "normal") return true;
  if (setType) return false;
  return true;
}

function parseMinifigNumbers(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function singleMinifigNumber(src = {}) {
  const ids = parseMinifigNumbers(src.minifigNumbers || src.MinifigNumbers);
  if (ids.length !== 1) return null;
  return ids[0];
}

function isCompleteOrSealedBox(src = {}) {
  const setType = normalizeSetType(src).toLowerCase();
  if (setType === "collection") return true;
  return /\bcomplete\b|sealed box/i.test(itemNameOf(src));
}

/**
 * CatalogPG key for a CMF row/doc.
 * Non-CMF → {}.
 * Figure with one col### → { itemType: MINIFIG, itemNumber, status: "ok" }.
 * Figure without col → { skip: true, reason: "missing_col" }.
 * Random pack NNNN-0 → { SET, NNNN-1 }.
 * Complete / Sealed Box → { skip: true, reason: "skip_no_bl_item" }.
 */
function resolveSourceLookup(src = {}) {
  if (!isCmfTheme(src)) return {};
  if (isCmfFigure(src)) {
    const col = singleMinifigNumber(src);
    if (col) {
      return { itemType: "MINIFIG", itemNumber: col, status: "ok" };
    }
    return { skip: true, reason: "missing_col" };
  }
  if (isCompleteOrSealedBox(src)) {
    return { skip: true, reason: "skip_no_bl_item" };
  }
  const itemNumber = itemNumberOf(src);
  const { base, variant } = parseVariantSuffix(itemNumber);
  if (variant === 0 && base) {
    return { itemType: "SET", itemNumber: `${base}-1`, status: "ok" };
  }
  if (itemNumber) {
    return { itemType: "SET", itemNumber, status: "ok" };
  }
  return { skip: true, reason: "skip_no_bl_item" };
}

/**
 * Prefer stored brickLink* fields; fall back to live resolve.
 */
function resolveSourceLookup(src = {}) {
  const storedType = String(src.brickLinkItemType || "").trim().toUpperCase();
  const storedNo = String(src.brickLinkNo || "").trim();
  if (storedType && storedNo) {
    return { itemType: storedType, itemNumber: storedNo, status: "ok" };
  }
  const status = String(src.brickLinkLookupStatus || "").trim();
  if (status === "missing_col" || status === "skip_no_bl_item") {
    return { skip: true, reason: status };
  }
  return resolveSourceLookup(src);
}

function sourceCatalogFields(src = {}) {
  if (!isCmfTheme(src)) return {};
  const setType = normalizeSetType(src);
  const lookup = resolveSourceLookup(src);
  const out = {};
  if (setType) out.bricksetSetType = setType;
  if (lookup.skip) {
    out.brickLinkLookupStatus = lookup.reason;
  } else if (lookup.itemType && lookup.itemNumber) {
    out.brickLinkItemType = lookup.itemType;
    out.brickLinkNo = lookup.itemNumber;
    out.brickLinkLookupStatus = "ok";
  }
  return out;
}

function catalogItemTypeForCmf(src = {}, { isGear = false } = {}) {
  if (isGear) return "GEAR";
  /** Вся линейка CMF (фигурки и random pack) — не наборы LEGO. */
  if (isCmfTheme(src)) return "MINIFIG";
  return "SET";
}

/** SET_71051-1 ↔ MINIFIG_71051-1 after CMF retype. */
function alternateCatalogDocId(id) {
  const s = String(id || "").trim();
  const m = s.match(/^(SET|MINIFIG)_(.+)$/i);
  if (!m) return null;
  const type = m[1].toUpperCase();
  const rest = m[2];
  return type === "SET" ? `MINIFIG_${rest}` : `SET_${rest}`;
}

function expandCatalogIdAliases(ids) {
  const out = new Set();
  for (const raw of ids || []) {
    const id = String(raw || "").trim();
    if (!id) continue;
    out.add(id);
    const alt = alternateCatalogDocId(id);
    if (alt) out.add(alt);
  }
  return out;
}

module.exports = {
  CMF_THEME_RE,
  CMF_THEME_PRIMARY_NAMES,
  PACK_NAME_RE,
  isCmfTheme,
  isCmfThemePrimary,
  cmfThemePrimaryQueryNames,
  isCmfFigure,
  isCmfPackOrCollection,
  parseMinifigNumbers,
  singleMinifigNumber,
  resolveSourceLookup,
  resolveSourceLookup,
  sourceCatalogFields,
  catalogItemTypeForCmf,
  itemNumberOf,
  alternateCatalogDocId,
  expandCatalogIdAliases,
};
