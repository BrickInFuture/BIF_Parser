/**
 * Process user-requested price refreshes from Firestore queue.
 *
 *   npm run ingest:bricklink:queue -- --confirm --limit=20
 *   npm run ingest:bricklink:queue -- --confirm --item=SET_75192-1
 *   npm run ingest:bricklink:queue -- --check-only
 *
 * Docs: price_refresh_requests/{catalogItemId}
 * status: pending → running → done | error
 *
 * --item=… processes that set immediately (priority / on-demand), not the bulk FIFO.
 * On scrape fail: observation error only — last-good bif_prices never overwritten.
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { BrickLinkSession } = require("./session");
const { normalizeSetNo } = require("./parseHtml");
const { writeObservationFromParse, writeRrpBootstrapObservation } = require("./observationWriter");
const { resolveBrickLinkFetch } = require("./blUrls");
const { pickCatalogRrpUsd, pickCatalogLaunchMs } = require("./catalogFields");
const { classifyCoverage } = require("./coveragePolicy");

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => String(a).startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const CONFIRM = hasFlag("confirm");
const HEADLESS = !hasFlag("headed");
const NO_BIF = hasFlag("no-bif");
const CHECK_ONLY = hasFlag("check-only");
const ITEM_ID = String(flagValue("item", "") || "").trim();
const LIMIT = Math.max(1, Number(flagValue("limit", "20")) || 20);
const MAX_MINUTES = Math.max(1, Number(flagValue("maxMinutes", "60")) || 60);
const STALE_RUNNING_MS = 45 * 60 * 1000;

function tsMs(v) {
  if (!v) return 0;
  if (typeof v.toDate === "function") return v.toDate().getTime();
  if (typeof v === "string" || typeof v === "number") {
    const n = new Date(v).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  if (v._seconds != null) return Number(v._seconds) * 1000;
  return 0;
}

async function countPending(db) {
  const snap = await db.collection("price_refresh_requests").where("status", "==", "pending").limit(1).get();
  return !snap.empty;
}

async function reclaimStaleRunning(db, FieldValue) {
  const snap = await db.collection("price_refresh_requests").where("status", "==", "running").limit(50).get();
  const now = Date.now();
  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const started = tsMs(d.startedAt) || tsMs(d.requestedAt);
    if (started && now - started > STALE_RUNNING_MS) {
      await doc.ref.set(
        {
          status: "pending",
          error: "reclaimed_stale_running",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      n += 1;
    }
  }
  return n;
}

async function listPending(db, limit) {
  const snap = await db
    .collection("price_refresh_requests")
    .where("status", "==", "pending")
    .limit(Math.min(100, limit * 3))
    .get();
  return snap.docs
    .map((doc) => {
      const d = doc.data() || {};
      return {
        id: doc.id,
        catalogItemId: d.catalogItemId || doc.id,
        itemNumber: normalizeSetNo(d.itemNumber) || null,
        itemType: String(d.itemType || "SET").toUpperCase(),
        priority: d.priority === true,
        requestedAtMs: tsMs(d.requestedAt),
        fast: d.priority === true,
      };
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return a.requestedAtMs - b.requestedAtMs;
    })
    .slice(0, limit);
}

/**
 * Force a single catalog item into the work list (on-demand from the site).
 * Ensures request doc exists as pending even if it was done/error/missing.
 */
async function resolvePriorityItem(db, FieldValue, catalogItemId) {
  const catSnap = await db.collection("catalog_items").doc(catalogItemId).get();
  if (!catSnap.exists) {
    throw new Error(`catalog_item_missing:${catalogItemId}`);
  }
  const cat = catSnap.data() || {};
  const fetch = resolveBrickLinkFetch(cat);
  const itemType = fetch.skip ? String(cat.itemType || "SET").toUpperCase() : fetch.itemType;
  const itemNumber = fetch.skip
    ? normalizeSetNo(cat.itemNumber) || String(cat.itemNumber || "").trim() || null
    : fetch.itemNumber;
  const ref = db.collection("price_refresh_requests").doc(catalogItemId);
  await ref.set(
    {
      catalogItemId,
      itemNumber,
      itemType,
      status: "pending",
      error: null,
      resultStatus: null,
      priority: true,
      updatedAt: FieldValue.serverTimestamp(),
      requestedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return {
    id: catalogItemId,
    catalogItemId,
    itemNumber,
    itemType,
    requestedAtMs: Date.now(),
    fast: true,
  };
}

async function resolveFetchFromCatalog(db, req) {
  const catSnap = await db.collection("catalog_items").doc(req.catalogItemId).get();
  if (catSnap.exists) {
    const fetch = resolveBrickLinkFetch(catSnap.data() || {});
    if (fetch.skip) return fetch;
    if (fetch.itemNumber) return fetch;
  }
  if (req.itemNumber) {
    return {
      skip: false,
      itemType: String(req.itemType || "SET").toUpperCase(),
      itemNumber: req.itemNumber,
    };
  }
  return { skip: true, reason: "missing_itemNumber" };
}

async function resolveSetNo(db, req) {
  const fetch = await resolveFetchFromCatalog(db, req);
  if (fetch.skip) return null;
  return fetch.itemNumber || null;
}

async function processOne(admin, db, FieldValue, session, req, summary) {
  const ref = db.collection("price_refresh_requests").doc(req.catalogItemId);
  const existing = await ref.get();
  if (existing.exists) {
    const d = existing.data() || {};
    const st = String(d.status || "");
    const started = tsMs(d.startedAt);
    const finished = tsMs(d.finishedAt);
    if (st === "running" && started && Date.now() - started < 90_000) {
      summary.push({ catalogItemId: req.catalogItemId, ok: true, skipped: "already_running" });
      return;
    }
    if (st === "done" && finished && Date.now() - finished < 8000) {
      summary.push({ catalogItemId: req.catalogItemId, ok: true, skipped: "already_done" });
      return;
    }
  }

  await ref.set(
    {
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      error: null,
    },
    { merge: true }
  );

  const fetch = await resolveFetchFromCatalog(db, req);
  if (fetch.skip) {
    const reason = fetch.reason || "skip_no_bl_item";
    await writeObservationFromParse(
      db,
      admin.firestore,
      {
        catalogItemId: req.catalogItemId,
        itemType: req.itemType || "SET",
        setNo: req.itemNumber || null,
        parsed: { ok: true, empty: true },
        method: "bricklink_lookup_skip",
        errorTag: reason,
      },
      { writeBif: false, dryRun: false }
    );
    await ref.set(
      {
        status: "done",
        error: null,
        resultStatus: "no_data",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    summary.push({ catalogItemId: req.catalogItemId, ok: true, resultStatus: "no_data", skip: reason });
    return;
  }

  const setNo = fetch.itemNumber;
  const fetchType = fetch.itemType || req.itemType || "SET";
  if (!setNo) {
    await ref.set(
      {
        status: "error",
        error: "catalog_item_missing_or_no_itemNumber",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    summary.push({ catalogItemId: req.catalogItemId, ok: false, error: "no_setNo" });
    return;
  }

  console.log(`… queue scrape ${fetchType} ${setNo} → ${req.catalogItemId}`);
  // Full-depth fetch for on-demand / Pro — no shallow fastFail.
  const scrape = await session.fetchSet(setNo, { itemType: fetchType });
  if (!scrape.parsed?.ok) {
    const err = scrape.parsed?.error || scrape.waitError || "scrape_failed";
    console.error(`FAIL ${setNo}:`, err);
    await writeObservationFromParse(
      db,
      admin.firestore,
      {
        catalogItemId: req.catalogItemId,
        itemType: req.itemType,
        setNo,
        parsed: scrape.parsed || { ok: false, error: err },
        method: scrape.method,
        errorTag: scrape.errorTag || null,
      },
      { writeBif: false, dryRun: false }
    );
    await ref.set(
      {
        status: "error",
        error: String(err).slice(0, 500),
        resultStatus: "error",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    summary.push({ catalogItemId: req.catalogItemId, setNo, ok: false, error: err });
    return;
  }

  const write = await writeObservationFromParse(
    db,
    admin.firestore,
    {
      catalogItemId: req.catalogItemId,
      itemType: req.itemType,
      setNo,
      parsed: scrape.parsed,
      method: scrape.method,
    },
    { writeBif: !NO_BIF, dryRun: false }
  );

  let resultStatus = scrape.parsed.empty ? "no_data" : "ok";
  let bifTypicalNew = write.bifTypicalNew ?? write.bifDoc?.new?.typicalUsd;
  if (scrape.parsed.empty && !NO_BIF) {
    let cat = {};
    try {
      const catSnap = await db.collection("catalog_items").doc(req.catalogItemId).get();
      if (catSnap.exists) cat = catSnap.data() || {};
    } catch {
      //
    }
    const rrp = pickCatalogRrpUsd(cat);
    const classif = classifyCoverage(cat);
    if (rrp != null && (classif.cohort === "novelty" || classif.cohort === "too_early")) {
      const boot = await writeRrpBootstrapObservation(
        db,
        admin.firestore,
        {
          catalogItemId: req.catalogItemId,
          itemType: req.itemType || "SET",
          setNo,
          rrpUsd: rrp,
          launchDateMs: pickCatalogLaunchMs(cat),
        },
        { dryRun: false }
      );
      if (boot.wrote) {
        resultStatus = "rrp_bootstrap_0_9";
        bifTypicalNew = boot.bifTypicalNew;
      }
    }
  }

  await ref.set(
    {
      status: "done",
      error: null,
      resultStatus,
      finishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      periodId: write.periodId || null,
    },
    { merge: true }
  );

  const row = {
    catalogItemId: req.catalogItemId,
    setNo,
    ok: true,
    resultStatus,
    bifTypicalNew,
    bifTypicalUsed: write.bifTypicalUsed ?? write.bifDoc?.used?.typicalUsd,
  };
  summary.push(row);
  console.log(JSON.stringify(row));
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();

  if (CHECK_ONLY) {
    const has = await countPending(db);
    console.log(JSON.stringify({ step: "price_refresh_queue_check", hasPending: has }));
    process.exitCode = 0;
    return;
  }

  const startedMs = Date.now();
  const deadlineMs = startedMs + MAX_MINUTES * 60 * 1000;

  let pending;
  if (ITEM_ID) {
    const one = await resolvePriorityItem(db, FieldValue, ITEM_ID);
    pending = [one];
    console.log(
      JSON.stringify(
        {
          step: "price_refresh_priority_item",
          catalogItemId: ITEM_ID,
          confirm: CONFIRM,
          writeBif: !NO_BIF,
          headless: HEADLESS,
        },
        null,
        2
      )
    );
  } else {
    const reclaimed = await reclaimStaleRunning(db, FieldValue);
    pending = await listPending(db, LIMIT);
    console.log(
      JSON.stringify(
        {
          step: "price_refresh_queue_start",
          confirm: CONFIRM,
          writeBif: !NO_BIF,
          limit: LIMIT,
          maxMinutes: MAX_MINUTES,
          reclaimed,
          pending: pending.length,
          headless: HEADLESS,
        },
        null,
        2
      )
    );
  }

  if (!pending.length) {
    console.log("No pending price_refresh_requests.");
    return;
  }

  if (!CONFIRM) {
    console.log("Dry-run. Pending ids:", pending.map((p) => p.catalogItemId).join(", "));
    console.log("Re-run with --confirm to scrape and write.");
    return;
  }

  const session = new BrickLinkSession({ headless: HEADLESS });
  const summary = [];

  try {
    await session.warmUp();

    for (const req of pending) {
      if (Date.now() >= deadlineMs) {
        console.log("Hit maxMinutes — leaving remaining pending.");
        break;
      }
      await processOne(admin, db, FieldValue, session, req, summary);
    }
  } finally {
    await session.close();
  }

  console.log("\n--- queue summary ---");
  console.log(JSON.stringify(summary, null, 2));
  const failed = summary.some((s) => !s.ok);
  if (failed) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  processOne,
  resolvePriorityItem,
  resolveSetNo,
  resolveFetchFromCatalog,
  reclaimStaleRunning,
  listPending,
};
