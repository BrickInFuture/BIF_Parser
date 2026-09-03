/**
 * Timed scrape of N random catalog sets that still have no usable BrickLink prices.
 *
 *   node scripts/bricklink-parser/ingestRandomNoPrice.js --confirm --limit=50
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { initFirebaseAdmin } = require("./firebaseAdmin");
const { BrickLinkSession, classifyErrorTag } = require("./session");
const { normalizeSetNo } = require("./parseHtml");
const { writeObservationFromParse } = require("./observationWriter");
const { observationDocId } = require("./catalogFields");
const { resolveBrickLinkFetch } = require("./blUrls");

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
const LIMIT = Math.max(1, Number(flagValue("limit", "50")) || 50);
const CANDIDATE_POOL = Math.max(LIMIT * 8, Number(flagValue("pool", "800")) || 800);
const OUT_DIR = path.join(__dirname, "out");

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** True if this observation already has real prices. */
function hasUsablePrices(obs) {
  if (!obs || obs.status !== "ok" || obs.empty) return false;
  const sides = [obs.soldNew, obs.soldUsed, obs.stockNew, obs.stockUsed];
  return sides.some(
    (s) =>
      s &&
      (s.avgUsd != null || s.qtyAvgUsd != null || s.minUsd != null || s.maxUsd != null)
  );
}

/**
 * Collect SET catalog candidates that currently lack usable BrickLink prices.
 * Mix of: never scraped + status error/no_data.
 */
async function collectNoPriceCandidates(db, poolTarget) {
  const candidates = [];
  let last = null;

  while (candidates.length < poolTarget) {
    let q = db
      .collection("catalog_items")
      .orderBy("__name__")
      .limit(150);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = [];
    for (const doc of snap.docs) {
      last = doc;
      const d = doc.data() || {};
      const itemType = String(d.itemType || "SET").toUpperCase();
      if (itemType !== "SET" && itemType !== "MINIFIG") continue;
      const fetch = resolveBrickLinkFetch(d);
      if (fetch.skip) continue;
      const setNo = fetch.itemNumber || normalizeSetNo(d.itemNumber);
      if (!setNo) continue;
      batch.push({ catalogItemId: doc.id, itemType: fetch.itemType || itemType, setNo });
    }

    // Parallel-ish observation lookups in chunks
    for (let i = 0; i < batch.length; i += 40) {
      const chunk = batch.slice(i, i + 40);
      const snaps = await Promise.all(
        chunk.map((row) =>
          db.collection("market_observations").doc(observationDocId(row.catalogItemId, "bricklink")).get()
        )
      );
      for (let j = 0; j < chunk.length; j += 1) {
        const obsSnap = snaps[j];
        const obs = obsSnap.exists ? obsSnap.data() : null;
        if (hasUsablePrices(obs)) continue;
        candidates.push({
          ...chunk[j],
          priorStatus: obs ? obs.status || null : "missing",
          priorError: obs && obs.error ? String(obs.error).slice(0, 120) : null,
        });
        if (candidates.length >= poolTarget) break;
      }
      if (candidates.length >= poolTarget) break;
    }
    if (snap.size < 150) break;
  }
  return candidates;
}

async function main() {
  const { admin, db } = initFirebaseAdmin();
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    JSON.stringify(
      {
        step: "random_no_price_start",
        confirm: CONFIRM,
        writeBif: !NO_BIF,
        limit: LIMIT,
        pool: CANDIDATE_POOL,
        headless: HEADLESS,
      },
      null,
      2
    )
  );

  const listStarted = Date.now();
  const pool = await collectNoPriceCandidates(db, CANDIDATE_POOL);
  shuffle(pool);
  const rows = pool.slice(0, LIMIT);
  console.log(
    JSON.stringify({
      step: "candidates",
      poolSize: pool.length,
      picked: rows.length,
      listSec: Math.round((Date.now() - listStarted) / 1000),
      priorStatusMix: rows.reduce((acc, r) => {
        acc[r.priorStatus || "missing"] = (acc[r.priorStatus || "missing"] || 0) + 1;
        return acc;
      }, {}),
    })
  );

  const summary = {
    limit: LIMIT,
    attempted: 0,
    ok_with_prices: 0,
    ok_empty: 0,
    fail: 0,
    byErrorTag: {},
    rows: [],
    listSec: Math.round((Date.now() - listStarted) / 1000),
  };

  const scrapeStarted = Date.now();
  const session = new BrickLinkSession({
    headless: HEADLESS,
    pauseMs: process.env.BL_PAUSE_MS ? undefined : [1500, 3000],
  });

  try {
    await session.warmUp();
    for (const row of rows) {
      summary.attempted += 1;
      console.log(`… ${summary.attempted}/${rows.length} ${row.setNo} → ${row.catalogItemId} (was ${row.priorStatus})`);

      let scrape;
      try {
        scrape = await session.fetchSet(row.setNo, { itemType: row.itemType || "SET" });
      } catch (e) {
        const err = String(e?.message || e);
        summary.fail += 1;
        summary.byErrorTag.exception = (summary.byErrorTag.exception || 0) + 1;
        summary.rows.push({
          setNo: row.setNo,
          catalogItemId: row.catalogItemId,
          priorStatus: row.priorStatus,
          ok: false,
          errorTag: "exception",
          error: err,
        });
        console.error(`FAIL ${row.setNo}:`, err);
        continue;
      }

      const parsed = scrape.parsed || { ok: false, error: scrape.waitError || "parse_failed" };
      const tag =
        scrape.errorTag ||
        classifyErrorTag(parsed, scrape.waitError) ||
        (parsed.ok ? (parsed.empty ? "empty" : "ok") : "parse_error");

      if (CONFIRM) {
        await writeObservationFromParse(
          db,
          admin.firestore,
          {
            catalogItemId: row.catalogItemId,
            itemType: row.itemType,
            setNo: row.setNo,
            parsed,
            method: scrape.method,
            errorTag: parsed.ok ? null : tag,
          },
          { writeBif: parsed.ok && !NO_BIF, dryRun: false }
        );
      }

      const entry = {
        setNo: row.setNo,
        catalogItemId: row.catalogItemId,
        priorStatus: row.priorStatus,
        ok: !!parsed.ok,
        empty: !!parsed.empty,
        errorTag: parsed.ok ? (parsed.empty ? "empty" : "ok") : tag,
        error: parsed.ok ? null : parsed.error || scrape.waitError || null,
        soldNew: parsed.soldNew?.qtyAvgUsd ?? parsed.soldNew?.avgUsd ?? null,
        stockNew: parsed.stockNew?.qtyAvgUsd ?? parsed.stockNew?.avgUsd ?? null,
        timing: scrape.timing || null,
      };
      summary.rows.push(entry);
      summary.byErrorTag[entry.errorTag] = (summary.byErrorTag[entry.errorTag] || 0) + 1;
      if (parsed.ok && !parsed.empty) summary.ok_with_prices += 1;
      else if (parsed.ok && parsed.empty) summary.ok_empty += 1;
      else summary.fail += 1;

      console.log(
        JSON.stringify({
          setNo: entry.setNo,
          ok: entry.ok,
          empty: entry.empty,
          errorTag: entry.errorTag,
          soldNew: entry.soldNew,
          stockNew: entry.stockNew,
          timing: entry.timing,
        })
      );
    }
  } finally {
    await session.close();
  }

  const scrapeSec = Math.round((Date.now() - scrapeStarted) / 1000);
  summary.scrapeSec = scrapeSec;
  summary.elapsedSec = Math.round((Date.now() - listStarted) / 1000);
  summary.avgSecPerSet = summary.attempted ? Math.round((scrapeSec / summary.attempted) * 10) / 10 : null;
  summary.successRatePct =
    summary.attempted > 0
      ? Math.round(((summary.ok_with_prices + summary.ok_empty) / summary.attempted) * 1000) / 10
      : 0;
  summary.priceSuccessRatePct =
    summary.attempted > 0
      ? Math.round((summary.ok_with_prices / summary.attempted) * 1000) / 10
      : 0;
  summary.dryRun = !CONFIRM;

  const outPath = path.join(OUT_DIR, `random-no-price-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log("\n--- random no-price ingest summary ---");
  console.log(
    JSON.stringify(
      {
        attempted: summary.attempted,
        ok_with_prices: summary.ok_with_prices,
        ok_empty: summary.ok_empty,
        fail: summary.fail,
        successRatePct: summary.successRatePct,
        priceSuccessRatePct: summary.priceSuccessRatePct,
        byErrorTag: summary.byErrorTag,
        listSec: summary.listSec,
        scrapeSec: summary.scrapeSec,
        elapsedSec: summary.elapsedSec,
        avgSecPerSet: summary.avgSecPerSet,
        dryRun: summary.dryRun,
        outPath,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
