/**
 * Очередь Brick Owl: primary без точки за lastClosed UTC-месяц.
 * Приоритет — свежие (catalogSortLaunch desc), не старые SET_10000.
 * Канон: BIF_parser.md § Brick Owl расписание.
 */
"use strict";

const { observationDocId } = require("../catalogFields");
const { lastClosedUtcYearMonth } = require("../gapLedger");
const { scoreCatalogPriority } = require("../catalogPriority");
const { LEDGER_STATUS, ledgerStatusFromMonthly } = require("../marketPoint");

const SOURCE = "brickowl";
/** Канон BIF_parser: SET → MINIFIG → GEAR */
const PRIMARY_TYPES = ["SET", "MINIFIG", "GEAR"];

function typePriorityRank(itemType) {
  const i = PRIMARY_TYPES.indexOf(String(itemType || "").toUpperCase());
  return i >= 0 ? i : 99;
}

function catalogReleaseYear(cat) {
  const y = Number(cat?.yearReleased ?? cat?.year);
  return Number.isFinite(y) && y > 0 ? y : 0;
}

/** Курсор по launch (старый string documentId — сбрасываем). */
function normalizeLaunchCursor(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const sort = Number(raw.sort);
  return { sort: Number.isFinite(sort) ? sort : 0, id };
}

function mapCatalogDocLite(doc) {
  const d = doc.data() || {};
  const itemType = String(d.itemType || "SET").toUpperCase();
  return {
    catalogItemId: doc.id,
    itemType,
    itemNumber: String(d.itemNumber || "").trim() || null,
    themePrimary: d.themePrimary || d.theme || null,
    theme: d.theme || null,
    itemName: d.itemName || null,
    yearReleased: d.yearReleased ?? d.year ?? null,
    launchDateMs: d.launchDateMs ?? null,
    launchDate: d.launchDate ?? null,
    catalogSortLaunch: d.catalogSortLaunch ?? null,
  };
}

/**
 * @returns {"missing"|"error"|"skip"}
 * no_data / ok за lastClosed → skip (в этом месяце не трогаем).
 * error → повтор; нет точки → новый съём.
 */
async function owlLastClosedKind(db, catalogItemId, periodId) {
  const obsId = observationDocId(catalogItemId, SOURCE);
  const snap = await db
    .collection("market_observations")
    .doc(obsId)
    .collection("monthly")
    .doc(periodId)
    .get();
  if (!snap.exists) return "missing";
  const st = ledgerStatusFromMonthly(snap.data() || {});
  if (st === LEDGER_STATUS.ERROR) return "error";
  if (st === LEDGER_STATUS.GAP) return "missing";
  return "skip";
}

async function owlLastClosedNeedsScrape(db, catalogItemId, periodId) {
  const kind = await owlLastClosedKind(db, catalogItemId, periodId);
  return kind === "missing" || kind === "error";
}

function sortOwlTasks(tasks) {
  return tasks.sort((a, b) => {
    // Сначала повторы после ошибки, потом новые дыры.
    const ra = a.retry ? 1 : 0;
    const rb = b.retry ? 1 : 0;
    if (rb !== ra) return rb - ra;
    const ta = typePriorityRank(a.cat?.itemType);
    const tb = typePriorityRank(b.cat?.itemType);
    if (ta !== tb) return ta - tb;
    if (b.score !== a.score) return b.score - a.score;
    const yb = catalogReleaseYear(b.cat);
    const ya = catalogReleaseYear(a.cat);
    if (yb !== ya) return yb - ya;
    const lb = Number(b.cat?.catalogSortLaunch) || 0;
    const la = Number(a.cat?.catalogSortLaunch) || 0;
    if (lb !== la) return lb - la;
    return a.cat.catalogItemId.localeCompare(b.cat.catalogItemId);
  });
}

/** Очередь повтора: корни __brickowl со status=error. */
async function fetchOwlErrorRetries(db, admin, opts = {}) {
  const periodId = opts.periodId || lastClosedUtcYearMonth();
  const maxTasks = Math.max(0, Number(opts.maxTasks) || 0);
  if (maxTasks <= 0) return { tasks: [], scanned: 0 };

  const tasks = [];
  let scanned = 0;
  let last = null;
  const seen = new Set();

  while (tasks.length < maxTasks && scanned < Math.max(maxTasks * 20, 200)) {
    let q = db
      .collection("market_observations")
      .where("source", "==", SOURCE)
      .where("status", "==", "error")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(80);
    if (last) q = q.startAfter(last);
    let snap;
    try {
      snap = await q.get();
    } catch (e) {
      console.log(
        JSON.stringify({
          step: "owl_error_queue_query_fail",
          error: String(e && e.message ? e.message : e),
        })
      );
      break;
    }
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned += 1;
      last = doc;
      const d = doc.data() || {};
      const catalogItemId = String(d.catalogItemId || doc.id.replace(/__brickowl$/, ""));
      if (!catalogItemId || seen.has(catalogItemId)) continue;
      const kind = await owlLastClosedKind(db, catalogItemId, periodId);
      if (kind !== "error") continue;
      seen.add(catalogItemId);
      const itemType = String(d.itemType || "SET").toUpperCase();
      if (!PRIMARY_TYPES.includes(itemType)) continue;
      tasks.push({
        cat: {
          catalogItemId,
          itemType,
          itemNumber: String(d.setNo || "").trim() || null,
          themePrimary: null,
          yearReleased: null,
          catalogSortLaunch: null,
        },
        periodId,
        retry: true,
        score: 20000,
      });
      if (tasks.length >= maxTasks) break;
    }
    if (snap.size < 80) break;
  }

  return { tasks, scanned };
}

/**
 * Набрать до maxTasks: сначала повторы error, потом свежие дыры (нет точки).
 * no_data / ok за lastClosed — не трогаем.
 */
async function fetchOwlGapQueue(db, admin, opts = {}) {
  const types = (opts.types || PRIMARY_TYPES).map((t) => String(t).toUpperCase());
  const maxTasks = Math.max(1, Number(opts.maxTasks) || 20);
  const retryBudget = Math.min(
    maxTasks,
    Math.max(1, Number(opts.retryBudget) || Math.round(maxTasks * 0.25) || 1)
  );
  const pageSize = Math.max(
    maxTasks * 10,
    Math.min(250, Number(opts.pageSize) || Math.max(maxTasks * 12, 120))
  );
  const periodId = opts.periodId || lastClosedUtcYearMonth();
  const prevCursors = { ...(opts.typeCursors || {}) };
  const typeCursors = {};

  const retries = await fetchOwlErrorRetries(db, admin, {
    periodId,
    maxTasks: retryBudget,
  });
  const pool = [...retries.tasks];
  const taken = new Set(pool.map((t) => t.cat.catalogItemId));
  let scanned = retries.scanned;
  const exhaustedTypes = [];

  for (const itemType of types) {
    if (pool.length >= maxTasks) {
      if (normalizeLaunchCursor(prevCursors[itemType])) {
        typeCursors[itemType] = normalizeLaunchCursor(prevCursors[itemType]);
      }
      continue;
    }

    const start = normalizeLaunchCursor(prevCursors[itemType]);
    let snap = null;
    let usedLaunchOrder = true;

    try {
      let q = db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy("catalogSortLaunch", "desc")
        .limit(pageSize);
      if (start?.id) {
        const curSnap = await db.collection("catalog_items").doc(start.id).get();
        if (curSnap.exists) q = q.startAfter(curSnap);
      }
      snap = await q.get();
    } catch (e) {
      console.log(
        JSON.stringify({
          step: "owl_queue_launch_query_fail",
          itemType,
          error: String(e && e.message ? e.message : e),
        })
      );
      usedLaunchOrder = false;
      const q = db
        .collection("catalog_items")
        .where("itemType", "==", itemType)
        .orderBy(admin.firestore.FieldPath.documentId(), "desc")
        .limit(pageSize);
      snap = await q.get();
    }

    if (!snap || snap.empty) {
      exhaustedTypes.push(itemType);
      typeCursors[itemType] = null;
      continue;
    }

    let lastCursor = start;
    for (const doc of snap.docs) {
      scanned += 1;
      const d = doc.data() || {};
      lastCursor = usedLaunchOrder
        ? { sort: Number(d.catalogSortLaunch) || 0, id: doc.id }
        : { sort: 0, id: doc.id };

      if (taken.has(doc.id)) continue;
      const cat = mapCatalogDocLite(doc);
      if (!cat.itemNumber) continue;
      const kind = await owlLastClosedKind(db, doc.id, periodId);
      // Только новые дыры в основной набор; error уже в retry-части.
      if (kind !== "missing") continue;

      taken.add(doc.id);
      pool.push({
        cat,
        periodId,
        retry: false,
        score: scoreCatalogPriority(cat, { skip: false, reason: "owl_last_closed_gap" }) + 5000,
      });
      if (pool.length >= maxTasks) break;
    }

    typeCursors[itemType] = lastCursor;
    if (snap.size < pageSize) exhaustedTypes.push(itemType);
  }

  const tasks = sortOwlTasks(pool).slice(0, maxTasks);

  return {
    periodId,
    scanned,
    tasks,
    typeCursors,
    exhaustedTypes,
    retryQueued: tasks.filter((t) => t.retry).length,
  };
}

module.exports = {
  SOURCE,
  PRIMARY_TYPES,
  mapCatalogDocLite,
  owlLastClosedKind,
  owlLastClosedNeedsScrape,
  fetchOwlErrorRetries,
  fetchOwlGapQueue,
  normalizeLaunchCursor,
};
