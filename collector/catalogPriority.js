/**
 * Scrape order: novelty (new launches) and popular LEGO themes first.
 * Used by ingestCatalog.js at window start + within each catalog page.
 */
"use strict";

const {
  classifyCoverage,
  NOVELTY_MAX_AGE_MS,
  DAY_MS,
} = require("./coveragePolicy");

/** themePrimary values as stored in catalog_items (Brickset Theme). */
const POPULAR_THEMES = [
  "Star Wars",
  "Star Wars™",
  "Ninjago",
  "NINJAGO",
  "City",
  "Technic",
  "Creator",
  "Harry Potter",
  "Harry Potter™",
  "Marvel Super Heroes",
  "Super Mario",
  "Super Mario™",
  "Minecraft",
  "Minecraft®",
  "Friends",
  "Speed Champions",
  "Icons",
  "Ideas",
  "Architecture",
  "DREAMZzz",
  "Monkie Kid",
  "Animal Crossing",
  "Fortnite",
  "Avatar",
  "Disney",
  "Disney™",
  "Jurassic World",
  "Jurassic World™",
  "DC Comics Super Heroes",
  "Spider-Man",
  "The Legend of Zelda",
  "Collectable Minifigures",
  "Classic",
  "Duplo",
  "DUPLO",
];

function normalizeThemeKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/™|®/g, "")
    .replace(/\s+/g, " ");
}

const POPULAR_THEME_KEYS = new Set(POPULAR_THEMES.map(normalizeThemeKey));

function pickThemeKey(cat) {
  return normalizeThemeKey(cat?.themePrimary || cat?.theme || "");
}

function isPopularTheme(cat) {
  const k = pickThemeKey(cat);
  if (!k) return false;
  if (POPULAR_THEME_KEYS.has(k)) return true;
  for (const p of POPULAR_THEME_KEYS) {
    if (k.includes(p) || p.includes(k)) return true;
  }
  return false;
}

/**
 * Higher score = scrape sooner.
 * @param {object} cat
 * @param {{ skip?: boolean, reason?: string, cohort?: string, launchMs?: number|null }} [coverage]
 */
function scoreCatalogPriority(cat, coverage = {}) {
  if (coverage.skip) return -1;

  const now = Date.now();
  const classif = classifyCoverage(cat, now);
  let score = 0;

  if (classif.cohort === "novelty") {
    score += 1000;
    if (classif.launchMs != null) {
      const ageMs = now - classif.launchMs;
      const freshness = Math.max(0, NOVELTY_MAX_AGE_MS - ageMs);
      score += Math.floor(freshness / DAY_MS);
    }
    if (coverage.reason === "novelty_need_month") score += 200;
  } else if (
    classif.cohort === "mature" &&
    (coverage.reason === "need_current_month" || coverage.reason === "mature_stale")
  ) {
    score += 120;
  }

  if (isPopularTheme(cat)) {
    score += 500;
    if (classif.cohort === "novelty") score += 300;
  }

  const yr = Number(cat.yearReleased);
  const thisYear = new Date().getFullYear();
  if (Number.isFinite(yr) && yr >= thisYear - 1) score += 80;

  return score;
}

function sortCatalogByPriority(items, coverageById = null) {
  return [...items].sort((a, b) => {
    const covA = coverageById?.get(a.catalogItemId) || {};
    const covB = coverageById?.get(b.catalogItemId) || {};
    const sa = scoreCatalogPriority(a, covA);
    const sb = scoreCatalogPriority(b, covB);
    if (sb !== sa) return sb - sa;
    return String(a.catalogItemId).localeCompare(String(b.catalogItemId));
  });
}

/** Light sort within a cursor page (no async coverage). */
function sortCatalogByPriorityLight(items) {
  return sortCatalogByPriority(items, null);
}

/**
 * Prefetch high-priority items for the start of an ingest window.
 * @param {FirebaseFirestore.Firestore} db
 * @param {*} admin firebase-admin module
 * @param {{ types?: string[], maxCandidates?: number, periodId: string, mapCatalogDoc: Function, resolveCoverage: Function }} opts
 */
async function fetchPriorityCandidates(db, admin, opts = {}) {
  const types = (opts.types || ["SET", "MINIFIG"]).map((t) => String(t).toUpperCase());
  const maxCandidates = Math.max(1, Number(opts.maxCandidates) || 80);
  const periodId = opts.periodId;
  const mapCatalogDoc = opts.mapCatalogDoc;
  const resolveCoverage = opts.resolveCoverage;
  if (!periodId || !mapCatalogDoc || !resolveCoverage) return [];

  const seen = new Set();
  const docs = [];

  async function addDocs(q, label) {
    if (docs.length >= maxCandidates * 4) return;
    try {
      const snap = await q.get();
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        docs.push(doc);
        if (docs.length >= maxCandidates * 4) break;
      }
    } catch (e) {
      console.log(
        JSON.stringify({
          step: "priority_query_fail",
          label,
          error: String(e?.message || e),
        })
      );
    }
  }

  const themeBatches = [];
  for (let i = 0; i < POPULAR_THEMES.length; i += 10) {
    themeBatches.push(POPULAR_THEMES.slice(i, i + 10));
  }

  for (const itemType of types) {
    await addDocs(
      db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy("catalogSortLaunch", "desc")
        .limit(Math.min(250, maxCandidates * 2)),
      `${itemType}_recent_launch`
    );

    for (const batch of themeBatches) {
      await addDocs(
        db
          .collection("catalog_items")
          .where("itemType", "==", itemType)
          .where("themePrimary", "in", batch)
          .orderBy(admin.firestore.FieldPath.documentId())
          .limit(60),
        `${itemType}_theme_${batch[0]}`
      );
    }
  }

  const cats = docs.map(mapCatalogDoc);
  const coverageById = new Map();
  const needs = [];

  for (const cat of cats) {
    const coverage = await resolveCoverage(db, cat, periodId);
    coverageById.set(cat.catalogItemId, coverage);
    if (!coverage.skip) {
      cat._coverage = coverage;
      needs.push(cat);
    }
  }

  return sortCatalogByPriority(needs, coverageById).slice(0, maxCandidates);
}

module.exports = {
  POPULAR_THEMES,
  normalizeThemeKey,
  isPopularTheme,
  scoreCatalogPriority,
  sortCatalogByPriority,
  sortCatalogByPriorityLight,
  fetchPriorityCandidates,
};
