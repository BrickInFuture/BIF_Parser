/**
 * Scrape order: novelty → newer release year → fan theme rank.
 * Used by ingestCatalog.js at window start + within each catalog page.
 * Канон: BIF_parser.md § Приоритет тем.
 */
"use strict";

const {
  classifyCoverage,
  NOVELTY_MAX_AGE_MS,
  DAY_MS,
} = require("./coveragePolicy");

const { PRIMARY_TYPES } = require("./ingestTypes");

function normalizeThemeKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/™|®/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Темы по убыванию интереса фанатов / вторички (выше = раньше в очереди).
 * Каждая строка — алиасы одной ступени (Brickset themePrimary).
 * Duplo — в самом низу (штраф ниже «неизвестной» темы).
 */
const THEME_PRIORITY_GROUPS = [
  ["Star Wars", "Star Wars™"],
  ["Icons"],
  ["Creator Expert"],
  ["Advanced models"],
  ["Technic"],
  ["Harry Potter", "Harry Potter™"],
  ["Marvel Super Heroes"],
  ["Spider-Man"],
  ["DC Comics Super Heroes"],
  ["Ninjago", "NINJAGO"],
  ["Architecture"],
  ["Ideas"],
  ["Speed Champions"],
  ["BrickHeadz"],
  ["Minecraft", "Minecraft®"],
  ["City"],
  ["Creator"],
  ["Super Mario", "Super Mario™"],
  ["Jurassic World", "Jurassic World™"],
  ["Disney", "Disney™"],
  ["Castle"],
  ["Space"],
  ["Pirates"],
  ["Collectable Minifigures"],
  ["DREAMZzz", "Dreamzzz"],
  ["Monkie Kid"],
  ["The Legend of Zelda"],
  ["Fortnite"],
  ["Animal Crossing"],
  ["Avatar"],
  ["Botanicals"],
  ["Classic"],
  ["Bionicle"],
  ["Mindstorms"],
  ["Trains"],
  ["Promotional"],
  ["Education"],
  ["Friends"],
  ["Juniors"],
  ["Explore"],
  ["Primo"],
  ["Baby"],
  ["Duplo", "DUPLO"],
];

/** Плоский список имён (для Firestore `in` и обратной совместимости). */
const POPULAR_THEMES = THEME_PRIORITY_GROUPS.flat();

/** Ступени без Duplo/дошколки — ими греем prefetch, не тратим слоты на хвост. */
const THEME_PREFETCH_GROUPS = THEME_PRIORITY_GROUPS.filter((g) => {
  const k = normalizeThemeKey(g[0]);
  return k !== "duplo" && k !== "juniors" && k !== "explore" && k !== "primo" && k !== "baby";
});

const THEME_PREFETCH_NAMES = THEME_PREFETCH_GROUPS.flat();

/** Макс. буст темы (Star Wars). Шаг между соседними ступенями. */
const THEME_BOOST_TOP = 120;
const THEME_BOOST_STEP = 3;
/** Ниже нуля: тема позже «безымянных». Duplo — ещё ниже дошколки. */
const THEME_BOOST_PRESCHOOL = -40;
const THEME_BOOST_DUPLO = -120;

/** @type {Map<string, number>} normalized key → group index (0 = highest) */
const THEME_RANK_BY_KEY = new Map();
for (let i = 0; i < THEME_PRIORITY_GROUPS.length; i++) {
  for (const name of THEME_PRIORITY_GROUPS[i]) {
    THEME_RANK_BY_KEY.set(normalizeThemeKey(name), i);
  }
}

const DUPLO_GROUP_INDEX = THEME_PRIORITY_GROUPS.findIndex(
  (g) => normalizeThemeKey(g[0]) === "duplo"
);
const PRESCHOOL_KEYS = new Set(["juniors", "explore", "primo", "baby"]);

function pickThemeKey(cat) {
  return normalizeThemeKey(cat?.themePrimary || cat?.theme || "");
}

/**
 * Индекс ступени (0 = Star Wars) или null, если темы нет в таблице.
 * @param {object|string} catOrTheme
 */
function themeRankIndex(catOrTheme) {
  const k =
    typeof catOrTheme === "string" ? normalizeThemeKey(catOrTheme) : pickThemeKey(catOrTheme);
  if (!k) return null;
  if (THEME_RANK_BY_KEY.has(k)) return THEME_RANK_BY_KEY.get(k);
  for (const [key, idx] of THEME_RANK_BY_KEY) {
    if (k.includes(key) || key.includes(k)) return idx;
  }
  return null;
}

/**
 * Добавка к score за тему. Выше = раньше съём.
 * Неизвестная тема = 0 (выше Duplo и дошколки).
 */
function themePriorityBoost(cat) {
  const k = pickThemeKey(cat);
  if (!k) return 0;
  if (k === "duplo" || k.includes("duplo")) return THEME_BOOST_DUPLO;
  if (PRESCHOOL_KEYS.has(k) || [...PRESCHOOL_KEYS].some((p) => k.includes(p))) {
    return THEME_BOOST_PRESCHOOL;
  }
  const idx = themeRankIndex(cat);
  if (idx == null) return 0;
  if (idx === DUPLO_GROUP_INDEX) return THEME_BOOST_DUPLO;
  const groupKey = normalizeThemeKey(THEME_PRIORITY_GROUPS[idx][0]);
  if (PRESCHOOL_KEYS.has(groupKey)) return THEME_BOOST_PRESCHOOL;
  return Math.max(0, THEME_BOOST_TOP - idx * THEME_BOOST_STEP);
}

/** Тема с положительным бустом (для тестов / отчётов). */
function isPopularTheme(cat) {
  return themePriorityBoost(cat) > 0;
}

/** Год выпуска набора (для порядка «сначала новые годы»). */
function catalogReleaseYear(cat) {
  const yr = Number(cat?.yearReleased);
  if (Number.isFinite(yr) && yr >= 1950 && yr <= 2100) return yr;
  const ms = cat?.launchDateMs != null ? Number(cat.launchDateMs) : NaN;
  if (Number.isFinite(ms) && ms > 0) {
    const y = new Date(ms).getUTCFullYear();
    if (Number.isFinite(y) && y >= 1950) return y;
  }
  return 0;
}

/**
 * Higher score = scrape sooner.
 * Порядок: новинки → год выпуска убывающий → ранг темы (фанаты).
 * @param {object} cat
 * @param {{ skip?: boolean, reason?: string, cohort?: string, launchMs?: number|null }} [coverage]
 */
function scoreCatalogPriority(cat, coverage = {}) {
  if (coverage.skip) return -1;

  const now = Date.now();
  const classif = classifyCoverage(cat, now);
  let score = 0;

  // База по году: 2026 >> 2018 (все должны пройти, но сначала свежие годы).
  score += catalogReleaseYear(cat) * 100;

  if (classif.cohort === "novelty") {
    score += 100000;
    if (classif.launchMs != null) {
      const ageMs = now - classif.launchMs;
      const freshness = Math.max(0, NOVELTY_MAX_AGE_MS - ageMs);
      score += Math.floor(freshness / DAY_MS);
    }
    if (coverage.reason === "novelty_need_month") score += 200;
  } else if (classif.cohort === "mature" && coverage.reason === "mature_stale") {
    score += 120;
  }

  const themeBoost = themePriorityBoost(cat);
  score += themeBoost;
  if (themeBoost > 0 && classif.cohort === "novelty") score += 100;

  return score;
}

function sortCatalogByPriority(items, coverageById = null) {
  return [...items].sort((a, b) => {
    const covA = coverageById?.get(a.catalogItemId) || {};
    const covB = coverageById?.get(b.catalogItemId) || {};
    const sa = scoreCatalogPriority(a, covA);
    const sb = scoreCatalogPriority(b, covB);
    if (sb !== sa) return sb - sa;
    const yb = catalogReleaseYear(b);
    const ya = catalogReleaseYear(a);
    if (yb !== ya) return yb - ya;
    const tb = themePriorityBoost(b);
    const ta = themePriorityBoost(a);
    if (tb !== ta) return tb - ta;
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
  const types = (opts.types || PRIMARY_TYPES).map((t) => String(t).toUpperCase());
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
  for (let i = 0; i < THEME_PREFETCH_NAMES.length; i += 10) {
    themeBatches.push(THEME_PREFETCH_NAMES.slice(i, i + 10));
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
  THEME_PRIORITY_GROUPS,
  POPULAR_THEMES,
  THEME_BOOST_TOP,
  THEME_BOOST_DUPLO,
  THEME_BOOST_PRESCHOOL,
  normalizeThemeKey,
  themeRankIndex,
  themePriorityBoost,
  isPopularTheme,
  catalogReleaseYear,
  scoreCatalogPriority,
  sortCatalogByPriority,
  sortCatalogByPriorityLight,
  fetchPriorityCandidates,
};
