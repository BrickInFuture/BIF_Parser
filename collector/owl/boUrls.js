/**
 * URL Brick Owl: поиск → карточка / boid.
 * cat: 3 = SET, 2 = MINIFIG, 4 = GEAR (иначе jump не находит).
 */
"use strict";

function brickOwlSearchCat(itemType) {
  const t = String(itemType || "SET").toUpperCase();
  if (t === "MINIFIG") return 2;
  if (t === "GEAR") return 4;
  return 3;
}

function brickOwlSearchSetUrl(setNo, itemType = "SET") {
  const q = encodeURIComponent(String(setNo || "").trim());
  const cat = brickOwlSearchCat(itemType);
  return `https://www.brickowl.com/search/catalog?query=${q}&jump=1&cat=${cat}`;
}

function brickOwlBoidUrl(boid) {
  return `https://www.brickowl.com/boid/${encodeURIComponent(String(boid || "").trim())}`;
}

/** SET_75192-1 → 75192-1 */
function setNoFromCatalogItemId(catalogItemId) {
  const id = String(catalogItemId || "").trim();
  const m = id.match(/^(?:SET_|MINIFIG_|GEAR_)?(.+)$/i);
  return m ? m[1] : id;
}

module.exports = {
  brickOwlSearchCat,
  brickOwlSearchSetUrl,
  brickOwlBoidUrl,
  setNoFromCatalogItemId,
};
