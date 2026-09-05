/**
 * Очередь задач из ledger-дыр (набор × месяц).
 * Канон: BIF_parser.md § Ledger.
 *
 * Один HTML-скрейп market пишет **все** помесячные sold-блоки со страницы
 * (не только последние 6 месяцев — на старых наборах бывают годы истории).
 *
 * Залп (канон с 2026-09): **50** без текущего UTC-месяца + **10** старых дыр
 * (при --limit=60). Порядок: новинки, потом по убыванию года выпуска.
 */
"use strict";

const { observationDocId } = require("./catalogFields");
const {
  classifyCoverage,
  resolveCatalogCoverage,
  LAUNCH_MIN_AGE_MS,
  NOVELTY_MAX_AGE_MS,
} = require("./coveragePolicy");
const {
  classifyPeriodSlot,
  periodIdsBetween,
  expectedPeriodIdsForItem,
  lastClosedUtcYearMonth,
  utcYearMonth,
} = require("./gapLedger");
const { LEDGER_STATUS } = require("./marketPoint");
const { scoreCatalogPriority, catalogReleaseYear } = require("./catalogPriority");
const { errorLooksLikeSoftBlock } = require("./parseHtml");

/** Не ставить в очередь то, что уже резали <24ч — иначе 60 слотов сгорают на SKIP. */
const SOFT_BLOCK_SKIP_MS = 24 * 60 * 60 * 1000;

function tsToMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v._seconds === "number") return v._seconds * 1000;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function recentlySoftBlocked(db, catalogItemId, maxAgeMs = SOFT_BLOCK_SKIP_MS) {
  const obsId = observationDocId(catalogItemId, "bricklink");
  const snap = await db.collection("market_observations").doc(obsId).get();
  if (!snap.exists) return false;
  const d = snap.data() || {};
  if (!errorLooksLikeSoftBlock(d.errorTag, d.error)) return false;
  const ms = tsToMs(d.updatedAt) || tsToMs(d.capturedAt);
  if (ms == null) return false;
  return Date.now() - ms < maxAgeMs;
}

/**
 * Бюджет залпа: сколько брать «нужен текущий месяц» и сколько «старые дыры».
 * По умолчанию 50+10 на каждые 60 мест (--limit).
 */
function resolveBurstBudgets(limit) {
  const lim = Math.max(0, Math.floor(Number(limit) || 0));
  const envCur = Number(process.env.BL_CURRENT_MONTH_BUDGET);
  const envHist = Number(process.env.BL_HISTORICAL_GAP_BUDGET);
  if (Number.isFinite(envCur) || Number.isFinite(envHist)) {
    const current = Number.isFinite(envCur) ? Math.max(0, Math.floor(envCur)) : 0;
    const historical = Number.isFinite(envHist) ? Math.max(0, Math.floor(envHist)) : 0;
    const curCap = Math.min(lim, current);
    const histCap = Math.min(Math.max(0, lim - curCap), historical);
    return { current: curCap, historical: histCap };
  }
  const current = Math.min(lim, Math.round((lim * 50) / 60));
  const historical = Math.min(Math.max(0, lim - current), Math.round((lim * 10) / 60));
  return { current, historical };
}

function periodsToCheckForGaps(cat, currentPeriodId, nowMs = Date.now()) {
  const classif = classifyCoverage(cat, nowMs);
  const out = new Set();

  // Все ожидаемые месяцы набора (launch+2d → сейчас) — HTML может закрыть старые дыры.
  for (const pid of expectedPeriodIdsForItem(
    { launchDateMs: classif.launchMs },
    nowMs
  )) {
    out.add(pid);
  }

  if (classif.cohort === "novelty" && classif.launchMs != null) {
    const scrapeStart = classif.launchMs + LAUNCH_MIN_AGE_MS;
    const scrapeEnd = Math.min(nowMs, classif.launchMs + NOVELTY_MAX_AGE_MS);
    for (const pid of periodIdsBetween(scrapeStart, scrapeEnd, { maxMonths: 14 })) {
      out.add(pid);
    }
  }

  if (currentPeriodId) out.add(currentPeriodId);
  out.add(utcYearMonth(new Date(nowMs)));

  return [...out];
}

async function loadMonthlyByPeriod(db, obsId, periodIds) {
  const map = new Map();
  if (!periodIds.length) return map;
  const col = db.collection("market_observations").doc(obsId).collection("monthly");
  const refs = periodIds.map((pid) => col.doc(pid));
  const snaps = await db.getAll(...refs);
  for (const snap of snaps) {
    if (snap.exists) map.set(snap.id, snap.data() || {});
  }
  return map;
}

/** Быстро: текущий UTC-месяц ещё не закрыт в ledger (дыра). */
async function currentMonthNeedsScrape(db, cat, currentPeriodId, nowMs = Date.now()) {
  const pid = currentPeriodId || utcYearMonth(new Date(nowMs));
  const obsId = observationDocId(cat.catalogItemId, "bricklink");
  const snap = await db
    .collection("market_observations")
    .doc(obsId)
    .collection("monthly")
    .doc(pid)
    .get();
  if (!snap.exists) return true;
  const slot = classifyPeriodSlot(pid, snap.data() || {});
  return slot.status === LEDGER_STATUS.GAP || slot.status === LEDGER_STATUS.ERROR;
}

async function findGapSlotsForItem(db, cat, currentPeriodId, nowMs = Date.now()) {
  const obsId = observationDocId(cat.catalogItemId, "bricklink");
  const check = periodsToCheckForGaps(cat, currentPeriodId, nowMs);
  const monthlyMap = await loadMonthlyByPeriod(db, obsId, check);
  return check.map((periodId) =>
    classifyPeriodSlot(periodId, monthlyMap.get(periodId) || null)
  );
}

/** Есть ли месяцы, которые HTML-страница может закрыть (≤ текущий UTC). */
function hasBlFillableGap(slots, nowMs = Date.now()) {
  const currentUtc = utcYearMonth(new Date(nowMs));
  return (slots || []).some(
    (s) => s.status === LEDGER_STATUS.GAP && s.periodId <= currentUtc
  );
}

/**
 * Текущий UTC-месяц уже закрыт в ledger (есть sold/stock/no_data/bootstrap).
 * Тогда повторный скрейп ради старых дыр — сжигание лимита: один HTML всё равно
 * не создаст сделки там, где их не было.
 */
function currentUtcMonthClosed(slots, nowMs = Date.now()) {
  const currentUtc = utcYearMonth(new Date(nowMs));
  const slot = (slots || []).find((s) => s.periodId === currentUtc);
  if (!slot) return false;
  return slot.status !== LEDGER_STATUS.GAP && slot.status !== LEDGER_STATUS.ERROR;
}

/**
 * Coverage говорит skip, но в ledger есть **несмотренные** дыры (status=gap) —
 * можно скрейпить. Месяцы no_data («смотрели, пусто») уже закрыты и сюда не попадают.
 */
function scrapeDespiteCoverageSkip(source, coverage, slots, nowMs = Date.now()) {
  if (!coverage || !coverage.skip) return false;
  if (!hasBlFillableGap(slots, nowMs)) return false;
  if (String(source || "") === "gap") return true;
  return true;
}

function scoreGapTask(cat, slots, currentPeriodId, coverage, nowMs = Date.now()) {
  let score = scoreCatalogPriority(cat, coverage || { skip: false });
  const gaps = slots.filter((s) => s.status === LEDGER_STATUS.GAP);
  const currentUtc = utcYearMonth(new Date(nowMs));
  const lastClosed = lastClosedUtcYearMonth(new Date(nowMs));
  const currentUtcGap = gaps.some((g) => g.periodId === currentUtc);
  const recentClosedGap = gaps.some((g) => g.periodId === lastClosed);
  const currentGap = gaps.some((g) => g.periodId === currentPeriodId);

  // №1 — нет точки за текущий UTC-месяц: новинки, потом год убывающий (в scoreCatalogPriority).
  if (currentUtcGap) {
    score += 5000;
    score += Math.min(gaps.length, 12) * 40;
    if (coverage && !coverage.skip && coverage.reason === "novelty_need_month") score += 500;
    if (coverage && !coverage.skip && coverage.reason === "mature_stale") score += 300;
    return score;
  }

  // №2 — текущий месяц уже есть; только несмотренные старые дыры (не no_data).
  score -= 2500;
  if (recentClosedGap) score += 900;
  else if (currentGap) score += 500;
  score += Math.min(gaps.length, 12) * 50;
  score += catalogReleaseYear(cat);
  return score;
}

/**
 * @param {{ onlyCurrentMonthGap?: boolean, onlyHistoricalGaps?: boolean }} [opts]
 */
async function fetchGapQueue(db, admin, opts) {
  const types = (opts.types || ["SET", "MINIFIG"]).map((t) => String(t).toUpperCase());
  const maxTasks = Math.max(1, Number(opts.maxTasks) || 80);
  // Текущий месяц: лёгкая проверка → можно сканировать далеко.
  // Старые дыры: полный ledger дороже → умеренный лимит.
  const envScan = Number(opts.maxScan);
  const defaultScan = opts.onlyCurrentMonthGap
    ? Math.max(maxTasks * 500, 25000)
    : Math.max(maxTasks * 80, 4000);
  const maxScan = Number.isFinite(envScan)
    ? Math.max(maxTasks, Math.floor(envScan))
    : defaultScan;
  const currentPeriodId = opts.currentPeriodId;
  const mapCatalogDoc = opts.mapCatalogDoc;
  const shardIndex = Number(opts.shardIndex) || 0;
  const shardCount = Math.max(1, Number(opts.shardCount) || 1);
  const excludeIds = opts.excludeIds || null;
  const onlyCurrentMonthGap = opts.onlyCurrentMonthGap === true;
  const onlyHistoricalGaps = opts.onlyHistoricalGaps === true;
  const nowMs = Date.now();

  const candidates = [];
  let scanned = 0;

  function shardOk(catalogItemId) {
    if (shardCount <= 1) return true;
    const s = String(catalogItemId || "");
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % shardCount === shardIndex;
  }

  for (const itemType of types) {
    let lastId = null;
    const wantPool = Math.max(maxTasks * 3, maxTasks);
    while (candidates.length < wantPool && scanned < maxScan) {
      let q = db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(120);
      if (lastId) q = q.startAfter(lastId);
      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        scanned += 1;
        if (scanned > maxScan) break;
        if (!shardOk(doc.id)) continue;
        if (excludeIds && excludeIds.has(doc.id)) continue;

        const cat = mapCatalogDoc(doc);
        if (!cat.itemNumber || !cat.supportedBlType || cat.mistypedGear) continue;
        if (opts.skipRecentSoftBlock !== false) {
          if (await recentlySoftBlocked(db, doc.id)) continue;
        }

        let slots;
        let gaps;
        let currentClosed;

        if (onlyCurrentMonthGap) {
          const needs = await currentMonthNeedsScrape(db, cat, currentPeriodId, nowMs);
          if (!needs) continue;
          currentClosed = false;
          gaps = [{ periodId: currentPeriodId || utcYearMonth(new Date(nowMs)), status: LEDGER_STATUS.GAP }];
          slots = gaps;
        } else {
          slots = await findGapSlotsForItem(db, cat, currentPeriodId, nowMs);
          gaps = slots.filter((s) => s.status === LEDGER_STATUS.GAP);
          if (!gaps.length || !hasBlFillableGap(slots, nowMs)) continue;
          currentClosed = currentUtcMonthClosed(slots, nowMs);
          if (onlyHistoricalGaps && !currentClosed) continue;
          if (!onlyHistoricalGaps && currentClosed && !hasBlFillableGap(slots, nowMs)) continue;
        }

        let coverage;
        const realCoverage = await resolveCatalogCoverage(db, cat, currentPeriodId, {
          nowMs,
        });
        if (realCoverage.skip) {
          coverage = {
            ...realCoverage,
            skip: false,
            reason: currentClosed ? "ledger_gap_historical" : "ledger_gap_override",
            coverageWouldSkip: true,
          };
        } else {
          coverage = {
            ...realCoverage,
            reason: realCoverage.reason || "ledger_gap",
            coverageWouldSkip: false,
          };
        }

        candidates.push({
          cat: { ...cat, _coverage: coverage },
          targetPeriodId: utcYearMonth(new Date(nowMs)),
          score: scoreGapTask(cat, slots, currentPeriodId, coverage, nowMs),
          gapCount: gaps.length,
          currentMonthGap: !currentClosed,
          coverage,
          gapPeriods: gaps.map((g) => g.periodId),
        });
      }

      lastId = snap.docs[snap.docs.length - 1].id;
      if (snap.size < 120) break;
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const yb = catalogReleaseYear(b.cat);
    const ya = catalogReleaseYear(a.cat);
    if (yb !== ya) return yb - ya;
    return a.cat.catalogItemId.localeCompare(b.cat.catalogItemId);
  });
  return candidates.slice(0, maxTasks);
}

module.exports = {
  periodsToCheckForGaps,
  findGapSlotsForItem,
  currentMonthNeedsScrape,
  currentUtcMonthClosed,
  hasBlFillableGap,
  scrapeDespiteCoverageSkip,
  scoreGapTask,
  fetchGapQueue,
  resolveBurstBudgets,
  recentlySoftBlocked,
  SOFT_BLOCK_SKIP_MS,
};
