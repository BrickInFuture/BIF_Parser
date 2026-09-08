/**
 * URL Brick Owl: поиск набора → карточка / boid.
 */
"use strict";

function brickOwlSearchSetUrl(setNo) {
  const q = encodeURIComponent(String(setNo || "").trim());
  return `https://www.brickowl.com/search/catalog?query=${q}&jump=1&cat=3`;
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
  brickOwlSearchSetUrl,
  brickOwlBoidUrl,
  setNoFromCatalogItemId,
};
