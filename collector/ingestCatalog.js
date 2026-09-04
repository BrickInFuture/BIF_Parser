/**
 * Catalog price ingest with type phases + checkpoint resume.
 *
 * Coverage / calendar rules: see PARSING_RULES.md
 *
 * Default (auto): SET + MINIFIG first. BOX / INSTRUCTION / GEAR only after primary
 * is exhausted for the month AND days remain (≤27 Moscow).
 * GHA scheduled runs use --phase=primary only (days 1–15).
 *
 *   npm run ingest:catalog -- --confirm --limit=500
 *   npm run ingest:catalog -- --confirm --phase=primary
 *   npm run ingest:catalog -- --confirm --phase=secondary
 *   npm run ingest:catalog -- --confirm --types=SET,MINIFIG
 *   npm run ingest:catalog -- --confirm --shardIndex=0 --shardCount=2
 *
 * Checkpoint: price_ingest_runs/market_{YYYY-MM} (or …_s{N} for shards)
 * Skips by coverage policy: novelty needs current month (after launch+2d);
 * mature only if last market ok older than ~6 months. Empty novelty → RRP×0.9 bootstrap.
 * Priority: gap queue (ledger holes) first, then catalog cursor.
 *   BL_GAP_QUEUE_RATIO=0.7  — share of --limit prefetched from gap queue (default 0.7)
 *   --queue=gap|cursor|both — gap only, cursor only, or gap then cursor (default both)
 * Skips recent soft_blocked observations (<24h) and jumps off a same-base variant cluster
 * after 2 consecutive soft-blocks so SET_8831-* cannot stall the monthly cursor.
 * Circuit (stop window) only when 5 distinct bases soft-block (IP likely hot).
 * Catalog pass uses shallow fetch (no deep soft_block/WAF retries). Retry-errors
 * skips soft_blocked younger than 24h and prefers parse_error.
 * On scrape fail: writes observation error, does NOT overwrite last-good bif_prices.
 *
 * Local Wi‑Fi tips: see LOCAL_WIFI.md — prefer --limit=300..500, pause after Oops/circuit storms.
 * Resume after a hot Oops wave (e.g. cursor near SET_2378) needs a cool-down first.
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { CollectorSession, HTTP_METHOD } = require("./session");
const { normalizeSetNo, errorLooksLikeSoftBlock } = require("./parseHtml");
const {
  isMistypedGearAsSet,
  normalizeItemNumber,
  BL_TYPE_PREFIX,
  resolveMarketFetch,
} = require("./blUrls");
const { writeObservationFromParse, writeRrpBootstrapObservation } = require("./observationWriter");
const { utcYearMonth } = require("./gapLedger");
const { observationDocId, pickCatalogLaunchMs, pickCatalogRrpUsd } = require("./catalogFields");
const { saveHttpAuth } = require("./httpAuthStore");
const { loadOrCreateRun, patchRun, runDocId } = require("./checkpoint");
const {
  PRIMARY_TYPES,
  resolveIngestTypes,
  moscowDayOfMonth,
} = require("./ingestTypes");
const { resolveCatalogCoverage } = require("./coveragePolicy");
const {
  sortCatalogByPriorityLight,
} = require("./catalogPriority");
const { fetchGapQueue, findGapSlotsForItem, scrapeDespiteCoverageSkip, hasBlFillableGap } = require("./gapQueue");
const { writeIngestArtifact } = require("./ingestReportArtifacts");

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/** Stable non-crypto hash for shard routing. */
function shardBucket(id, shardCount) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return shardCount > 0 ? h % shardCount : 0;
}

const CONFIRM = hasFlag("confirm");
const HEADLESS = !hasFlag("headed");
const NO_BIF = hasFlag("no-bif");
const RESET_RUN = hasFlag("reset-run");
const LIMIT = Math.max(1, Number(flagValue("limit", "500")) || 500);
const MAX_MINUTES = Math.max(1, Number(flagValue("maxMinutes", "180")) || 180);
const SHARD_COUNT = Math.max(1, Number(flagValue("shardCount", "1")) || 1);
const SHARD_INDEX = Math.min(
  SHARD_COUNT - 1,
  Math.max(0, Number(flagValue("shardIndex", "0")) || 0)
);
const PHASE_FLAG = String(flagValue("phase", "auto") || "auto").toLowerCase();
const TYPES_CSV = flagValue("types", null);
const QUEUE_MODE = String(flagValue("queue", "both") || "both").toLowerCase();

async function alreadyOkThisPeriod(db, catalogItemId, periodId, cat) {
  const obsId = observationDocId(catalogItemId, "bricklink");
  const monthly = await db
    .collection("market_observations")
    .doc(obsId)
    .collection("monthly")
    .doc(periodId)
    .get();
  if (!monthly.exists) return false;
  const d = monthly.data() || {};
  const st = String(d.status || "");
  if (st === "ok") return true;
  if (st === "no_data") {
    const tag = String(d.errorTag || "");
    if (tag === "missing_col") {
      const fetch = resolveMarketFetch(cat || {});
      if (!fetch.skip && fetch.itemNumber) return false;
    }
    // rrp_bootstrap counts as month filled for novelty; plain no_data too (legacy)
    return true;
  }
  return false;
}

/** Do not re-scrape a hot shell for a day; advance the cursor instead. */
const SOFT_BLOCK_SKIP_MS = 24 * 60 * 60 * 1000;
/** Consecutive soft-blocks on the same base number (8831-1, 8831-2, …) before skipping the rest. */
const SAME_BASE_SOFT_JUMP = 2;
/** Distinct bases that soft-blocked this window before we treat the IP as hot. */
const MIXED_BASE_CIRCUIT = 5;
/** After a hot-IP cool: skip this many catalog pages (×50) so we leave the sticky zone. */
const HOT_ZONE_JUMP_PAGES = Math.max(
  1,
  Number(process.env.BL_HOT_ZONE_JUMP_PAGES || 3) || 3
);
const HOT_ZONE_JUMP_PAGE_SIZE = 50;

function catalogBaseKey(itemType, itemNumber) {
  const num = String(itemNumber || "").trim();
  const m = num.match(/^(.*)-(\d+)$/);
  const base = m ? m[1] : num || "";
  return `${String(itemType || "SET").toUpperCase()}|${base}`;
}

function tsToMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v._seconds === "number") return v._seconds * 1000;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isSoftBlockTag(tag, err) {
  return errorLooksLikeSoftBlock(tag, err);
}

async function recentlySoftBlocked(db, catalogItemId, maxAgeMs = SOFT_BLOCK_SKIP_MS) {
  const obsId = observationDocId(catalogItemId, "bricklink");
  const snap = await db.collection("market_observations").doc(obsId).get();
  if (!snap.exists) return false;
  const d = snap.data() || {};
  if (!isSoftBlockTag(d.errorTag, d.error)) return false;
  const ms = tsToMs(d.updatedAt) || tsToMs(d.capturedAt);
  if (ms == null) return false;
  return Date.now() - ms < maxAgeMs;
}

function mapCatalogDoc(doc) {
  const d = doc.data() || {};
  const itemType = String(d.itemType || "SET").toUpperCase();
  const catalog = {
    itemType,
    itemNumber: d.itemNumber,
    themePrimary: d.themePrimary || d.theme || null,
    theme: d.theme || null,
    itemName: d.itemName || null,
    minifigNumbers: d.minifigNumbers || null,
    bricksetSetType: d.bricksetSetType || null,
    bricksetCategory: d.bricksetCategory || null,
    brickLinkItemType: d.brickLinkItemType || null,
    brickLinkNo: d.brickLinkNo || null,
    brickLinkLookupStatus: d.brickLinkLookupStatus || null,
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

/**
 * Page catalog_items for one itemType (SET / MINIFIG / …).
 * Cursor = last catalogItemId within that type.
 */
async function fetchCatalogPageByType(db, admin, itemType, cursorCatalogId, pageSize) {
  let q = db
    .collection("catalog_items")
    .where("itemType", "==", String(itemType || "SET").toUpperCase())
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(pageSize);

  if (cursorCatalogId) {
    q = q.startAfter(cursorCatalogId);
  }

  const snap = await q.get();
  return snap.docs.map(mapCatalogDoc);
}

/** True if stored cursor belongs to the active type (avoid BOX_* cursor on SET phase). */
function cursorMatchesType(cursorCatalogId, itemType) {
  if (!cursorCatalogId) return true;
  const prefix = `${String(itemType || "").toUpperCase()}_`;
  return String(cursorCatalogId).toUpperCase().startsWith(prefix);
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const startedMs = Date.now();
  let deadlineMs = startedMs + MAX_MINUTES * 60 * 1000;
  const runId =
    SHARD_COUNT > 1 ? `${runDocId(periodId)}_s${SHARD_INDEX}` : runDocId(periodId);

  const run = await loadOrCreateRun(db, periodId, FieldValue, {
    reset: RESET_RUN,
    dryRun: !CONFIRM,
    runId,
  });

  if (run.alreadyDone && !RESET_RUN) {
    console.log(`Run ${run.id} already status=done for ${periodId}. Use --reset-run to restart.`);
    return;
  }

  let primaryExhausted = RESET_RUN ? false : run.data.primaryExhausted === true;
  let typePlan = resolveIngestTypes({
    phase: PHASE_FLAG,
    typesCsv: TYPES_CSV,
    primaryExhausted,
    dayOfMonth: moscowDayOfMonth(),
  });
  let activeTypes = [...typePlan.types];
  let typeIndex = 0;
  /** Per-type catalog cursors so SET/MINIFIG can interleave without starving either. */
  let typeCursors = RESET_RUN ? {} : { ...(run.data.typeCursors || {}) };
  const savedCursorType = RESET_RUN ? null : run.data.cursorType || null;
  if (savedCursorType && !RESET_RUN && run.data.cursorCatalogId && !typeCursors[savedCursorType]) {
    typeCursors[savedCursorType] = run.data.cursorCatalogId;
  }
  if (savedCursorType) {
    const idx = activeTypes.indexOf(String(savedCursorType).toUpperCase());
    if (idx >= 0) typeIndex = idx;
  }

  console.log(
    JSON.stringify(
      {
        step: "catalog_ingest_start",
        periodId,
        runId,
        confirm: CONFIRM,
        writeBif: !NO_BIF,
        limit: LIMIT,
        maxMinutes: MAX_MINUTES,
        resetRun: RESET_RUN,
        headless: HEADLESS,
        phase: typePlan.phase,
        phaseReason: typePlan.reason,
        activeTypes,
        primaryExhausted,
        catalogPass: true,
        limitCountsScrapesOnly: true,
        shardIndex: SHARD_INDEX,
        shardCount: SHARD_COUNT,
        queueMode: QUEUE_MODE,
        proxyConfigured: Boolean(String(process.env.BL_PROXY_URL || "").trim()),
      },
      null,
      2
    )
  );

  if (CONFIRM) {
    await patchRun(
      run.ref,
      FieldValue,
      {
        circuitOpenThisWindow: false,
        ingestPhase: typePlan.phase,
        activeTypes,
        primaryExhausted,
      },
      false
    );
  }

  // Prefer catalog-id cursor within current itemType.
  let cursorType = activeTypes[typeIndex] || PRIMARY_TYPES[0];
  let cursorCatalogId = RESET_RUN
    ? null
    : typeCursors[cursorType] || run.data.cursorCatalogId || null;
  const legacyAllTypesCursor = !RESET_RUN && !run.data.cursorType && run.data.itemType === "ALL";
  if (legacyAllTypesCursor) {
    // Old ALL-types runs left the cursor near the end of SET_*; with scrape-only LIMIT
    // we can safely restart primary from SET_10000 and skip already-ok without burning budget.
    console.log(
      JSON.stringify({
        step: "cursor_reset_phase_migration",
        was: cursorCatalogId,
        reason: "legacy_ALL_types_cursor",
      })
    );
    cursorCatalogId = null;
    typeCursors = {};
    typeIndex = 0;
    cursorType = activeTypes[0] || "SET";
  } else if (!cursorMatchesType(cursorCatalogId, cursorType)) {
    // Old ALL-types cursor (e.g. BOX_*) must not poison SET/MINIFIG phase.
    console.log(
      JSON.stringify({
        step: "cursor_reset_type_mismatch",
        was: cursorCatalogId,
        cursorType,
      })
    );
    cursorCatalogId = null;
    delete typeCursors[cursorType];
  }
  typeCursors[cursorType] = cursorCatalogId || null;
  let cursorItemNumber = RESET_RUN ? null : run.data.cursorItemNumber || null;
  let processed = RESET_RUN ? 0 : Number(run.data.processed) || 0;
  let ok = RESET_RUN ? 0 : Number(run.data.ok) || 0;
  let fail = RESET_RUN ? 0 : Number(run.data.fail) || 0;
  let skipped = RESET_RUN ? 0 : Number(run.data.skipped) || 0;
  let okWithPrices = RESET_RUN ? 0 : Number(run.data.okWithPrices) || 0;
  let noData = RESET_RUN ? 0 : Number(run.data.noData) || 0;
  // Breaks "fail" down by cause (blocked / timeout / partial_prices / …) so reports don't
  // lump "site blocked us" together with "our price-reading rule failed".
  // errorTagCounts = накопительно за месяц; chunkErrorTagCounts = только этот залп (для телеги).
  let errorTagCounts = RESET_RUN ? {} : { ...(run.data.errorTagCounts || {}) };
  let chunkErrorTagCounts = {};
  let timingStats = RESET_RUN
    ? { okCount: 0, okTotalMs: 0, softCount: 0, softTotalMs: 0 }
    : {
        okCount: Number(run.data.timingStats?.okCount) || 0,
        okTotalMs: Number(run.data.timingStats?.okTotalMs) || 0,
        softCount: Number(run.data.timingStats?.softCount) || 0,
        softTotalMs: Number(run.data.timingStats?.softTotalMs) || 0,
      };
  let chunkDone = 0;
  let chunkOkWithPrices = 0;
  let chunkNoData = 0;
  let gapRefills = 0;
  let lastError = null;
  let exhausted = false;
  let stopWindow = false;
  let skipBaseKey = null;
  let sameBaseSoftStreak = 0;
  let lastSoftBaseKey = null;
  const mixedSoftBases = new Set();
  let circuitOpenThisWindow = false;
  // Очередь страницы/дыр снаружи try — прыжок курсора должен уметь её сбросить.
  let pendingItems = [];
  /** После волны «сайт режет» не забиваем окно снова очередью дыр (она отменяла прыжок). */
  let gapPausedAfterHot = false;

  function noteClusterSoft(cat) {
    const base = catalogBaseKey(cat.itemType, cat.itemNumber);
    if (base === lastSoftBaseKey) sameBaseSoftStreak += 1;
    else {
      lastSoftBaseKey = base;
      sameBaseSoftStreak = 1;
    }
    mixedSoftBases.add(base);
    return {
      base,
      jump: sameBaseSoftStreak >= SAME_BASE_SOFT_JUMP,
      mixedCircuit: mixedSoftBases.size >= MIXED_BASE_CIRCUIT,
      sameBaseSoftStreak,
      mixedBases: mixedSoftBases.size,
    };
  }

  function noteClusterOk() {
    sameBaseSoftStreak = 0;
    lastSoftBaseKey = null;
  }

  /**
   * После волны «сайт режет» не остаёмся на тех же номерах:
   * сбрасываем очередь страницы и прыгаем курсор на несколько страниц вперёд.
   */
  async function jumpCursorPastHotZone(reason) {
    const fromId = cursorCatalogId;
    pendingItems = [];
    // Дыры (популярные «дыры в месяцах») снова бьют в горячий IP — до конца окна только курсор.
    gapPausedAfterHot = true;
    let pagesJumped = 0;
    let lastId = cursorCatalogId;
    for (let i = 0; i < HOT_ZONE_JUMP_PAGES; i += 1) {
      const page = await fetchCatalogPageByType(
        db,
        admin,
        cursorType,
        lastId,
        HOT_ZONE_JUMP_PAGE_SIZE
      );
      if (!page.length) break;
      lastId = page[page.length - 1].catalogItemId;
      cursorItemNumber = page[page.length - 1].itemNumber || cursorItemNumber;
      pagesJumped += 1;
    }
    if (lastId && lastId !== cursorCatalogId) {
      cursorCatalogId = lastId;
      typeCursors[cursorType] = cursorCatalogId;
    }
    skipBaseKey = null;
    console.log(
      JSON.stringify({
        step: "catalog_cursor_jump_ahead",
        reason: reason || "hot_zone",
        from: fromId,
        to: cursorCatalogId,
        pagesJumped,
        pageSize: HOT_ZONE_JUMP_PAGE_SIZE,
        circuitTrips: session.circuitTrips || 0,
        gapPausedAfterHot: true,
      })
    );
    await saveCheckpoint();
  }

  function applyClusterAfterSoft(cat) {
    const cluster = noteClusterSoft(cat);
    if (cluster.jump) {
      skipBaseKey = cluster.base;
      session.clearSoftBlockStreak();
      console.log(
        JSON.stringify({
          step: "catalog_jump_base",
          base: cluster.base,
          sameBaseSoftStreak: cluster.sameBaseSoftStreak,
          mixedBases: cluster.mixedBases,
          cursorCatalogId,
        })
      );
    }
    // Mixed-base heat: jump the current base and reset streak counters.
    // Session soft-circuit already cools+continues; do not kill the whole window here
    // unless BL_CIRCUIT_STOP=1 (legacy stop behavior).
    if (cluster.mixedCircuit) {
      skipBaseKey = cluster.base;
      session.clearSoftBlockStreak();
      mixedSoftBases.clear();
      sameBaseSoftStreak = 0;
      lastSoftBaseKey = null;
      if (process.env.BL_CIRCUIT_STOP === "1" || session.isCircuitOpen()) {
        circuitOpenThisWindow = true;
        lastError = "circuit_open_stop_window";
        stopWindow = true;
        console.log(
          JSON.stringify({
            step: "catalog_stop_mixed_bases",
            mixedBases: cluster.mixedBases,
            circuitTrips: session.circuitTrips,
            cursorCatalogId,
          })
        );
      } else {
        circuitOpenThisWindow = false;
        // Реальный уход: очередь сбросим и курсор уведём в jumpCursorPastHotZone (async).
        cluster.needsCursorJump = true;
        console.log(
          JSON.stringify({
            step: "catalog_cool_mixed_bases",
            mixedBases: cluster.mixedBases,
            circuitTrips: session.circuitTrips,
            cursorCatalogId,
            action: "jump_cursor_ahead",
          })
        );
      }
    } else if (session.isCircuitOpen()) {
      circuitOpenThisWindow = true;
      lastError = "circuit_open_stop_window";
      stopWindow = true;
      console.log(
        JSON.stringify({
          step: "catalog_stop_circuit",
          circuitTrips: session.circuitTrips,
          cursorCatalogId,
        })
      );
    }
    return cluster;
  }

  function noteErrorTag(tag) {
    const key = tag || "unknown";
    errorTagCounts[key] = (errorTagCounts[key] || 0) + 1;
    chunkErrorTagCounts[key] = (chunkErrorTagCounts[key] || 0) + 1;
  }

  function noteTiming(scrape) {
    const totalMs = Number(scrape?.timing?.totalMs) || 0;
    if (!totalMs) return;
    if (scrape?.parsed?.ok && !scrape?.parsed?.blocked) {
      timingStats.okCount += 1;
      timingStats.okTotalMs += totalMs;
      return;
    }
    if (scrape?.errorTag === "soft_blocked" || /soft.?block/i.test(String(scrape?.waitError || ""))) {
      timingStats.softCount += 1;
      timingStats.softTotalMs += totalMs;
    }
  }

  const session = new CollectorSession({
    headless: HEADLESS,
    pauseMs: process.env.BL_PAUSE_MS ? undefined : [1500, 3000],
  });

  let scrapeStartedMs = startedMs;

  async function saveCheckpoint(extra = {}) {
    if (!CONFIRM) return;
    await patchRun(
      run.ref,
      FieldValue,
      {
        status: "running",
        itemType: cursorType || "SET",
        ingestPhase: typePlan.phase,
        activeTypes,
        primaryExhausted,
        cursorType,
        typeCursors,
        cursorItemNumber,
        cursorCatalogId,
        processed,
        ok,
        fail,
        skipped,
        okWithPrices,
        noData,
        lastError,
        errorTagCounts,
        timingStats,
        circuitTrips: session.circuitTrips || 0,
        circuitOpenThisWindow,
        shardIndex: SHARD_INDEX,
        shardCount: SHARD_COUNT,
        ...extra,
      },
      false
    );
  }

  function persistTypeCursor() {
    typeCursors[cursorType] = cursorCatalogId || null;
  }

  /** Round-robin across remaining active types so MINIFIG is not starved behind SET. */
  function rotateTypeAfterPage() {
    if (activeTypes.length <= 1) return;
    persistTypeCursor();
    typeIndex = (typeIndex + 1) % activeTypes.length;
    cursorType = activeTypes[typeIndex];
    cursorCatalogId = typeCursors[cursorType] || null;
    cursorItemNumber = null;
    console.log(
      JSON.stringify({
        step: "catalog_rotate_type",
        cursorType,
        typeIndex,
        activeTypes,
        cursorCatalogId,
      })
    );
  }

  function advanceToNextType() {
    persistTypeCursor();
    // Drop exhausted type from rotation.
    const exhaustedType = cursorType;
    activeTypes = activeTypes.filter((t) => t !== exhaustedType);
    if (activeTypes.length) {
      typeIndex = typeIndex % activeTypes.length;
      cursorType = activeTypes[typeIndex];
      cursorCatalogId = typeCursors[cursorType] || null;
      cursorItemNumber = null;
      console.log(
        JSON.stringify({
          step: "catalog_advance_type",
          exhaustedType,
          cursorType,
          typeIndex,
          activeTypes,
        })
      );
      return true;
    }

    if (typePlan.phase === "primary" && PHASE_FLAG === "auto") {
      primaryExhausted = true;
      const next = resolveIngestTypes({
        phase: "auto",
        primaryExhausted: true,
        dayOfMonth: moscowDayOfMonth(),
      });
      if (next.phase === "secondary" && next.types.length) {
        typePlan = next;
        activeTypes = [...next.types];
        typeIndex = 0;
        cursorType = activeTypes[0];
        cursorCatalogId = typeCursors[cursorType] || null;
        cursorItemNumber = null;
        console.log(
          JSON.stringify({
            step: "catalog_switch_secondary",
            reason: next.reason,
            activeTypes,
          })
        );
        return true;
      }
      console.log(
        JSON.stringify({
          step: "catalog_primary_exhausted",
          reason: next.reason,
          primaryExhausted: true,
        })
      );
      return false;
    }

    return false;
  }

  try {
    const gapRatio =
      QUEUE_MODE === "cursor"
        ? 0
        : Number(process.env.BL_GAP_QUEUE_RATIO) ||
          (QUEUE_MODE === "gap" ? 1 : Number(process.env.BL_PRIORITY_RATIO) || 0.7);
    const gapBudget =
      QUEUE_MODE === "cursor"
        ? 0
        : Math.min(
            LIMIT,
            Math.max(0, Math.floor(LIMIT * (Number.isFinite(gapRatio) ? gapRatio : 0.7)))
          );
    pendingItems = [];
    const gapHandled = new Set();

    async function buildGapPendingItems(maxTasks, maxScan) {
      if (!CONFIRM || gapBudget <= 0 || QUEUE_MODE === "cursor") return [];
      const gapTasks = await fetchGapQueue(db, admin, {
        types: activeTypes,
        maxTasks,
        maxScan,
        currentPeriodId: periodId,
        mapCatalogDoc,
        shardIndex: SHARD_INDEX,
        shardCount: SHARD_COUNT,
        excludeIds: gapHandled,
      });
      return gapTasks.map((task) => ({
        cat: task.cat,
        source: "gap",
        targetPeriodId: task.targetPeriodId,
        gapCount: task.gapCount,
        gapPeriods: task.gapPeriods,
      }));
    }

    const setupStartedMs = Date.now();
    const [, initialGapItems] = await Promise.all([
      session.warmUp(),
      buildGapPendingItems(
        gapBudget,
        Math.max(gapBudget * 25, 500)
      ),
    ]);
    try {
      if (session.httpCookieHeader) {
        await saveHttpAuth(db, FieldValue, {
          cookieHeader: session.httpCookieHeader,
          userAgent: session.httpUserAgent || null,
          source: "ingest_catalog",
        });
      }
    } catch (authErr) {
      console.warn("http_auth_save_failed", authErr && authErr.message ? authErr.message : authErr);
    }
    pendingItems = initialGapItems;
    deadlineMs = Date.now() + MAX_MINUTES * 60 * 1000;
    scrapeStartedMs = Date.now();
    console.log(
      JSON.stringify({
        step: "scrape_window_start",
        setupSec: Math.round((Date.now() - setupStartedMs) / 1000),
        maxMinutes: MAX_MINUTES,
        deadlineIso: new Date(deadlineMs).toISOString(),
      })
    );
    if (pendingItems.length) {
      console.log(
        JSON.stringify({
          step: "gap_queue_built",
          size: pendingItems.length,
          budget: gapBudget,
          queueMode: QUEUE_MODE,
          periodId,
        })
      );
    }

    /** Снимок для телеги, если GitHub отменил job посреди окна. */
    function flushPartialCatalogArtifact(reason) {
      const scrapeElapsedSec = Math.max(1, Math.round((Date.now() - scrapeStartedMs) / 1000));
      const chunkSuccessPct =
        chunkDone > 0 ? Math.round((chunkOkWithPrices / chunkDone) * 1000) / 10 : null;
      const secPerOkWithPrices =
        chunkOkWithPrices > 0
          ? Math.round((scrapeElapsedSec / chunkOkWithPrices) * 10) / 10
          : null;
      writeIngestArtifact("catalog", {
        runId: run.id,
        periodId,
        status: "aborted",
        abortedReason: reason || "signal",
        timedOut: false,
        chunkDone,
        chunkOkWithPrices,
        chunkNoData,
        chunkSuccessPct,
        scrapeElapsedSec,
        secPerOkWithPrices,
        okPerHour:
          chunkOkWithPrices > 0
            ? Math.round((chunkOkWithPrices / scrapeElapsedSec) * 3600 * 10) / 10
            : null,
        ok,
        fail,
        skipped,
        errorTagCounts,
        chunkErrorTagCounts,
        circuitTrips: session.circuitTrips || 0,
        circuitOpen: session.isCircuitOpen(),
        circuitOpenThisWindow,
        gapPausedAfterHot,
        cursorCatalogId,
        elapsedSec: Math.round((Date.now() - startedMs) / 1000),
        dryRun: !CONFIRM,
      });
    }
    const onAbortSignal = (sig) => {
      try {
        stopWindow = true;
        flushPartialCatalogArtifact(sig);
      } catch (_) {
        /* ignore */
      }
      process.exit(143);
    };
    process.once("SIGTERM", () => onAbortSignal("SIGTERM"));
    process.once("SIGINT", () => onAbortSignal("SIGINT"));

    async function refillGapQueueIfNeeded() {
      if (QUEUE_MODE === "cursor" || gapBudget <= 0 || !CONFIRM) return false;
      if (gapPausedAfterHot) {
        console.log(
          JSON.stringify({
            step: "gap_queue_skip_after_hot",
            chunkDone,
            reason: "resume_cursor_only",
          })
        );
        return false;
      }
      const remaining = LIMIT - chunkDone;
      if (remaining <= 0 || Date.now() >= deadlineMs) return false;
      const batchSize = Math.min(remaining, Math.max(40, Math.floor(gapBudget / 2)));
      const refill = await buildGapPendingItems(
        batchSize,
        Math.max(batchSize * 12, 240)
      );
      if (!refill.length) return false;
      pendingItems.push(...refill);
      gapRefills += 1;
      console.log(
        JSON.stringify({
          step: "gap_queue_refill",
          added: refill.length,
          pending: pendingItems.length,
          gapRefills,
          chunkDone,
        })
      );
      return true;
    }

    while (!stopWindow && chunkDone < LIMIT && Date.now() < deadlineMs) {
      if (!pendingItems.length) {
        if (QUEUE_MODE === "gap") {
          exhausted = true;
          break;
        }
        const refilled = await refillGapQueueIfNeeded();
        if (refilled) continue;

        const pageSize = Math.min(50, Math.max(10, LIMIT - chunkDone));
        const page = await fetchCatalogPageByType(
          db,
          admin,
          cursorType,
          cursorCatalogId,
          pageSize
        );
        if (!page.length) {
          const moved = advanceToNextType();
          if (!moved) {
            exhausted = true;
            break;
          }
          await saveCheckpoint();
          continue;
        }

        pendingItems = sortCatalogByPriorityLight(page)
          .filter((cat) => !gapHandled.has(cat.catalogItemId))
          .map((cat) => ({ cat, source: "cursor" }));
        rotateTypeAfterPage();
        if (!pendingItems.length) continue;
      }

      const { cat, source } = pendingItems.shift();
      if (stopWindow || chunkDone >= LIMIT || Date.now() >= deadlineMs) break;

      if (source === "cursor") {
        cursorCatalogId = cat.catalogItemId;
        cursorItemNumber = cat.itemNumber || cursorItemNumber;
        cursorType = cat.itemType || cursorType;
      }

        if (SHARD_COUNT > 1 && shardBucket(cat.catalogItemId, SHARD_COUNT) !== SHARD_INDEX) {
          // Advance cursor through other shards without counting toward LIMIT scrape budget.
          continue;
        }

        const setNo = cat.itemNumber;
        if (!setNo) {
          fail += 1;
          processed += 1;
          chunkDone += 1;
          lastError = `missing_itemNumber:${cat.catalogItemId}`;
          await saveCheckpoint();
          continue;
        }

        if (!cat.supportedBlType) {
          skipped += 1;
          processed += 1;
          console.log(`SKIP ${cat.catalogItemId} (unsupported itemType ${cat.itemType})`);
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          continue;
        }

        if (cat.mistypedGear) {
          skipped += 1;
          processed += 1;
          console.log(`SKIP ${setNo} (mistyped Gear as SET — ${cat.catalogItemId})`);
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          continue;
        }

        if (CONFIRM) {
          const coverage =
            cat._coverage || (await resolveCatalogCoverage(db, cat, periodId));
          if (coverage.skip) {
            const slots = await findGapSlotsForItem(db, cat, periodId);
            if (!scrapeDespiteCoverageSkip(source, coverage, slots)) {
              skipped += 1;
              processed += 1;
              console.log(`SKIP ${setNo} (${coverage.reason})`);
              if (source === "gap") gapHandled.add(cat.catalogItemId);
              continue;
            }
            cat._coverage = { ...coverage, skip: false, reason: "ledger_gap_override" };
          } else {
            cat._coverage = coverage;
          }
        }

        // Cursor: текущий месяц уже есть → мимо.
        // Gap: текущий есть, но остались несмотренные старые дыры → можно добрать.
        if (await alreadyOkThisPeriod(db, cat.catalogItemId, periodId, cat)) {
          if (source === "gap") {
            const slots = await findGapSlotsForItem(db, cat, periodId);
            if (!hasBlFillableGap(slots)) {
              skipped += 1;
              processed += 1;
              console.log(`SKIP ${setNo} (already ok ${periodId}, no unread gaps)`);
              gapHandled.add(cat.catalogItemId);
              continue;
            }
          } else {
            skipped += 1;
            processed += 1;
            console.log(`SKIP ${setNo} (already ok ${periodId})`);
            continue;
          }
        }

        if (cat.blFetch?.skip) {
          skipped += 1;
          processed += 1;
          const skipReason = cat.blFetch.reason || "skip_no_bl_item";
          console.log(`SKIP ${setNo} (${skipReason} — ${cat.catalogItemId})`);
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          if (CONFIRM) {
            await writeObservationFromParse(
              db,
              admin.firestore,
              {
                catalogItemId: cat.catalogItemId,
                itemType: cat.itemType,
                setNo,
                parsed: { ok: true, empty: true },
                method: "lookup_skip",
                errorTag: skipReason,
              },
              { writeBif: false, dryRun: false }
            );
          }
          continue;
        }

        const baseKey = catalogBaseKey(cat.itemType, cat.itemNumber);
        if (skipBaseKey && baseKey === skipBaseKey) {
          skipped += 1;
          processed += 1;
          console.log(`SKIP ${setNo} (cluster jump ${skipBaseKey})`);
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          continue;
        }

        if (CONFIRM && (await recentlySoftBlocked(db, cat.catalogItemId))) {
          skipped += 1;
          processed += 1;
          // Иначе очередь дыр снова подсовывает тот же набор по кругу.
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          console.log(`SKIP ${setNo} (soft_blocked <24h)`);
          continue;
        }

        if (session.isCircuitOpen()) {
          lastError = "circuit_open_stop_window";
          stopWindow = true;
          console.log(
            JSON.stringify({
              step: "catalog_stop_circuit",
              circuitTrips: session.circuitTrips,
              cursorCatalogId,
            })
          );
          break;
        }

        const fetchType = cat.blFetch?.itemType || cat.itemType || "SET";
        const fetchNo = cat.blFetch?.itemNumber || setNo;
        console.log(
          `… scrape ${fetchType} ${fetchNo} → ${cat.catalogItemId}${source === "gap" ? " [gap]" : ""}`
        );
        let scrape;
        try {
          scrape = await session.fetchSet(fetchNo, {
            itemType: fetchType,
            catalogPass: true,
          });
        } catch (e) {
          lastError = String(e?.message || e);
          if (/circuit_open/i.test(lastError)) {
            circuitOpenThisWindow = true;
            skipBaseKey = catalogBaseKey(cat.itemType, cat.itemNumber);
            stopWindow = true;
            console.log(JSON.stringify({ step: "catalog_stop_circuit", error: lastError }));
            break;
          }
          console.error(`FAIL ${fetchNo}:`, lastError);
          fail += 1;
          processed += 1;
          chunkDone += 1;
          noteErrorTag("exception");
          if (CONFIRM) {
            await writeObservationFromParse(
              db,
              admin.firestore,
              {
                catalogItemId: cat.catalogItemId,
                itemType: cat.itemType,
                setNo: fetchNo,
                parsed: { ok: false, error: lastError },
                method: HTTP_METHOD,
                errorTag: "exception",
              },
              { writeBif: false, dryRun: false }
            );
          }
          await saveCheckpoint();
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          if (isSoftBlockTag("exception", lastError)) {
            const cluster = applyClusterAfterSoft(cat);
            if (cluster?.needsCursorJump) await jumpCursorPastHotZone("mixed_soft_exception");
          }
          continue;
        }

        noteTiming(scrape);

        if (!scrape.parsed?.ok) {
          lastError = scrape.parsed?.error || scrape.waitError || "parse_failed";
          console.error(`FAIL ${fetchNo}:`, lastError);
          fail += 1;
          processed += 1;
          chunkDone += 1;
          noteErrorTag(scrape.errorTag);
          if (CONFIRM) {
            await writeObservationFromParse(
              db,
              admin.firestore,
              {
                catalogItemId: cat.catalogItemId,
                itemType: cat.itemType,
                setNo: fetchNo,
                parsed: scrape.parsed || { ok: false, error: lastError },
                method: scrape.method,
                errorTag: scrape.errorTag || null,
              },
              { writeBif: false, dryRun: false }
            );
          }
          await saveCheckpoint();
          if (source === "gap") gapHandled.add(cat.catalogItemId);
          if (isSoftBlockTag(scrape.errorTag, lastError)) {
            const cluster = applyClusterAfterSoft(cat);
            if (cluster?.needsCursorJump) await jumpCursorPastHotZone("mixed_soft_block");
          } else if (session.isCircuitOpen()) {
            circuitOpenThisWindow = true;
            lastError = "circuit_open_stop_window";
            stopWindow = true;
          }
          if (stopWindow) break;
          continue;
        }

        const write = await writeObservationFromParse(
          db,
          admin.firestore,
          {
            catalogItemId: cat.catalogItemId,
            itemType: cat.itemType,
            setNo: fetchNo,
            parsed: scrape.parsed,
            method: scrape.method,
          },
          { writeBif: !NO_BIF, dryRun: !CONFIRM }
        );

        noteClusterOk();
        const empty = !!scrape.parsed.empty;
        ok += 1;
        let bootstrapTypical = null;
        if (empty) {
          noData += 1;
          chunkNoData += 1;
          const cov = cat._coverage || {};
          const rrp = cov.rrpUsd != null ? Number(cov.rrpUsd) : pickCatalogRrpUsd(cat);
          const rrpOk = Number.isFinite(rrp) && rrp > 0;
          if (
            CONFIRM &&
            !NO_BIF &&
            rrpOk &&
            (cov.preferBootstrapIfEmpty || cov.cohort === "novelty")
          ) {
            const boot = await writeRrpBootstrapObservation(
              db,
              admin.firestore,
              {
                catalogItemId: cat.catalogItemId,
                itemType: cat.itemType,
                setNo: fetchNo,
                rrpUsd: rrp,
                launchDateMs: cov.launchMs ?? pickCatalogLaunchMs(cat),
              },
              { dryRun: false }
            );
            if (boot.wrote) {
              bootstrapTypical = boot.bifTypicalNew;
              okWithPrices += 1;
              chunkOkWithPrices += 1;
            }
          }
        } else {
          okWithPrices += 1;
          chunkOkWithPrices += 1;
        }
        processed += 1;
        chunkDone += 1;
        console.log(
          JSON.stringify({
            setNo: fetchNo,
            catalogItemId: cat.catalogItemId,
            itemType: cat.itemType,
            ok: true,
            empty,
            status: empty ? (bootstrapTypical != null ? "rrp_bootstrap_0_9" : "no_data") : "ok",
            bifTypicalNew: bootstrapTypical ?? write.bifTypicalNew ?? write.bifDoc?.new?.typicalUsd,
            bifTypicalUsed: write.bifTypicalUsed ?? write.bifDoc?.used?.typicalUsd,
            dryRun: write.dryRun,
            writtenPeriodIds: write.writtenPeriodIds || [write.periodId],
            bifPeriodId: write.bifPeriodId || write.periodId,
          })
        );
        await saveCheckpoint();
        if (source === "gap") gapHandled.add(cat.catalogItemId);
    }
  } finally {
    await session.close();
  }

  const timedOut = Date.now() >= deadlineMs && !exhausted;
  const status = exhausted ? "done" : "running";
  const attempted = ok + fail;
  // Накопительный % за месяц (ok / ok+fail) — не путать с этим окном.
  const successPct = attempted > 0 ? Math.round((ok / attempted) * 1000) / 10 : null;
  // Честный % именно этого прогона: цены / запросы.
  const chunkSuccessPct =
    chunkDone > 0 ? Math.round((chunkOkWithPrices / chunkDone) * 1000) / 10 : null;
  const scrapeElapsedSec = Math.max(1, Math.round((Date.now() - scrapeStartedMs) / 1000));
  // Стена времени окна / число успешных цен — сколько реально уходит на 1 цену.
  const secPerOkWithPrices =
    chunkOkWithPrices > 0
      ? Math.round((scrapeElapsedSec / chunkOkWithPrices) * 10) / 10
      : null;
  const okPerHour =
    chunkOkWithPrices > 0 && scrapeElapsedSec > 0
      ? Math.round((chunkOkWithPrices / scrapeElapsedSec) * 3600 * 10) / 10
      : null;

  if (CONFIRM) {
    await patchRun(
      run.ref,
      FieldValue,
      {
        status,
        itemType: cursorType || "SET",
        ingestPhase: typePlan.phase,
        activeTypes,
        primaryExhausted,
        cursorType,
        typeCursors,
        cursorItemNumber,
        cursorCatalogId,
        processed,
        ok,
        fail,
        skipped,
        okWithPrices,
        noData,
        errorTagCounts,
        timingStats,
        circuitTrips: session.circuitTrips || 0,
        circuitOpenThisWindow,
        lastError: circuitOpenThisWindow
          ? lastError || "circuit_open_stop_window"
          : /circuit_open/i.test(String(lastError || ""))
            ? null
            : lastError,
        shardIndex: SHARD_INDEX,
        shardCount: SHARD_COUNT,
        ...(exhausted ? { finishedAt: FieldValue.serverTimestamp() } : {}),
      },
      false
    );
  }

  const avgSecOk =
    timingStats.okCount > 0
      ? Math.round((timingStats.okTotalMs / timingStats.okCount / 1000) * 10) / 10
      : null;
  const avgSecSoft =
    timingStats.softCount > 0
      ? Math.round((timingStats.softTotalMs / timingStats.softCount / 1000) * 10) / 10
      : null;

  const summary = {
    runId: run.id,
    periodId,
    status,
    exhausted,
    timedOut,
    phase: typePlan.phase,
    phaseReason: typePlan.reason,
    activeTypes,
    primaryExhausted,
    cursorType,
    chunkDone,
    chunkOkWithPrices,
    chunkNoData,
    gapRefills,
    processed,
    ok,
    okWithPrices,
    noData,
    fail,
    skipped,
    successPct,
    chunkSuccessPct,
    scrapeElapsedSec,
    secPerOkWithPrices,
    okPerHour,
    errorTagCounts,
    chunkErrorTagCounts,
    timingStats,
    avgSecOk,
    avgSecSoft,
    circuitTrips: session.circuitTrips || 0,
    circuitOpen: session.isCircuitOpen(),
    circuitOpenThisWindow,
    skipBaseKey,
    mixedSoftBases: mixedSoftBases.size,
    gapPausedAfterHot,
    cursorItemNumber,
    cursorCatalogId,
    shardIndex: SHARD_INDEX,
    shardCount: SHARD_COUNT,
    elapsedSec: Math.round((Date.now() - startedMs) / 1000),
    dryRun: !CONFIRM,
  };

  console.log("\n--- catalog ingest summary ---");
  console.log(JSON.stringify(summary, null, 2));
  writeIngestArtifact("catalog", summary);
  if (!CONFIRM) console.log("Dry-run only. Re-run with --confirm to write Firestore.");

  // В raw-only (публичный репозиторий) закрытую аналитику не трогаем —
  // system_stats обновит приватная сторона. Модуль functions/ там может отсутствовать.
  if (CONFIRM && ok > 0 && process.env.BL_RAW_ONLY !== "1") {
    try {
      const { refreshLegoMarketGrowthStats } = require("./_privateDisabled");
      const growth = await refreshLegoMarketGrowthStats(db, { FieldValue });
      console.log("Refreshed system_stats/lego_market_growth:", growth);
    } catch (e) {
      console.warn("lego_market_growth refresh skipped:", e && e.message ? e.message : e);
    }
  }

  if (fail > 0 && ok === 0 && chunkDone > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
