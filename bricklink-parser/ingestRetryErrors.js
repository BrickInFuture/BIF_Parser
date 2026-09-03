/**
 * Retry BrickLink observations that failed this month (status=error).
 *
 * Prefers SET + MINIFIG. Secondary types (BOX / INSTRUCTION / GEAR) only when
 * primary errors are empty or --phase=secondary / --types=… overrides.
 *
 *   npm run ingest:bricklink:retry-errors -- --confirm --limit=100 --maxMinutes=60
 *
 * Does not forget failures: re-scrapes until ok/no_data or still error (will retry next night).
 * Last-good bif_prices are never overwritten on fail.
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { BrickLinkSession, HTTP_METHOD } = require("./session");
const { normalizeSetNo } = require("./parseHtml");
const { writeObservationFromParse } = require("./observationWriter");
const { utcYearMonth } = require("./gapLedger");
const { loadOrCreateRun, patchRun, runDocId } = require("./checkpoint");
const { resolveBrickLinkFetch } = require("./blUrls");
const { writeIngestArtifact } = require("./ingestReportArtifacts");
const {
  PRIMARY_TYPES,
  SECONDARY_TYPES,
  resolveIngestTypes,
  moscowDayOfMonth,
} = require("./ingestTypes");

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
const LIMIT = Math.max(1, Number(flagValue("limit", "100")) || 100);
const MAX_MINUTES = Math.max(1, Number(flagValue("maxMinutes", "60")) || 60);
const PHASE_FLAG = String(flagValue("phase", "auto") || "auto").toLowerCase();
const TYPES_CSV = flagValue("types", null);

async function listErrorObservations(db, admin, wantLimit, typePlan) {
  const pooled = [];
  let last = null;
  const maxScan = Math.max(wantLimit * 25, 2500);
  let scanned = 0;

  while (pooled.length < wantLimit * 3 && scanned < maxScan) {
    let q = db
      .collection("market_observations")
      .where("source", "==", "bricklink")
      .where("status", "==", "error")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(200);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      scanned += 1;
      last = doc;
      const d = doc.data() || {};
      pooled.push({
        obsId: doc.id,
        catalogItemId: d.catalogItemId || String(doc.id).replace(/__bricklink$/, ""),
        itemType: String(d.itemType || "SET").toUpperCase(),
        setNo: normalizeSetNo(d.setNo) || null,
        error: d.error || null,
        errorTag: d.errorTag || null,
        updatedAtMs:
          (d.updatedAt && typeof d.updatedAt.toMillis === "function" && d.updatedAt.toMillis()) ||
          (d.capturedAt && typeof d.capturedAt.toMillis === "function" && d.capturedAt.toMillis()) ||
          0,
      });
    }
    if (snap.size < 200) break;
  }

  const picked = pickRetryRows(pooled, typePlan);
  // Prefer older failures so we don't thrash the same hot soft_blocks.
  picked.sort((a, b) => (a.updatedAtMs || 0) - (b.updatedAtMs || 0));
  return picked.slice(0, wantLimit);
}

function pickRetryRows(errors, typePlan) {
  const allowed = new Set(typePlan.types.map((t) => String(t).toUpperCase()));
  const primary = [];
  const secondary = [];
  const other = [];
  for (const row of errors) {
    const t = String(row.itemType || "SET").toUpperCase();
    if (PRIMARY_TYPES.includes(t)) primary.push(row);
    else if (SECONDARY_TYPES.includes(t)) secondary.push(row);
    else other.push(row);
  }

  if (typePlan.phase === "custom") {
    return errors.filter((r) => allowed.has(String(r.itemType || "SET").toUpperCase()));
  }
  if (typePlan.phase === "secondary") {
    return [...secondary, ...other.filter((r) => allowed.has(r.itemType))];
  }
  // primary / auto: SET+MINIFIG first; only fall through to secondary if none left
  if (primary.length) return primary;
  if (typePlan.allowSecondary || PHASE_FLAG === "secondary") return secondary;
  return primary;
}

async function main() {
  const { admin, db, FieldValue } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const startedMs = Date.now();
  const deadlineMs = startedMs + MAX_MINUTES * 60 * 1000;

  const runRef = db.collection("price_ingest_runs").doc(runDocId(periodId));
  const runSnap = await runRef.get();
  const runData = runSnap.data() || {};
  let retryOk = Number(runData.retryOk) || 0;
  let retryFail = Number(runData.retryFail) || 0;

  const typePlan = resolveIngestTypes({
    phase: PHASE_FLAG,
    typesCsv: TYPES_CSV,
    primaryExhausted: runData.primaryExhausted === true,
    dayOfMonth: moscowDayOfMonth(),
  });

  console.log(
    JSON.stringify(
      {
        step: "bricklink_retry_errors_start",
        periodId,
        confirm: CONFIRM,
        writeBif: !NO_BIF,
        limit: LIMIT,
        maxMinutes: MAX_MINUTES,
        headless: HEADLESS,
        phase: typePlan.phase,
        phaseReason: typePlan.reason,
        activeTypes: typePlan.types,
      },
      null,
      2
    )
  );

  // Defer retry only when monthly soft-block rate is extreme.
  // Do NOT skip solely for circuitOpenThisWindow — cool briefly and continue clearing
  // SET/MINIFIG errors (catalog already cooled or stopped; retry is the recovery path).
  const tags = runData.errorTagCounts || {};
  const softN = Number(tags.soft_blocked) || 0;
  const attemptedMonth = (Number(runData.ok) || 0) + (Number(runData.fail) || 0);
  const softRate = attemptedMonth > 0 ? softN / attemptedMonth : 0;
  const softRateMax = Number(process.env.BL_RETRY_SOFT_RATE_MAX || 0.55);
  const circuitThisWindow = runData.circuitOpenThisWindow === true;
  if (attemptedMonth >= 40 && softRate >= softRateMax) {
    const skip = {
      step: "retry_skipped_hot_session",
      softRate: Math.round(softRate * 1000) / 1000,
      softRateMax,
      soft_blocked: softN,
      attemptedMonth,
      lastError: runData.lastError || null,
      circuitOpenThisWindow: circuitThisWindow,
      circuitTrips: runData.circuitTrips || 0,
    };
    console.log(JSON.stringify(skip));
    console.log("\n--- retry-errors summary ---");
    console.log(
      JSON.stringify(
        {
          periodId,
          skipped: true,
          reason: "soft_block_rate",
          ...skip,
          dryRun: !CONFIRM,
        },
        null,
        2
      )
    );
    return;
  }

  if (circuitThisWindow) {
    const coolMs = Number(process.env.BL_RETRY_CIRCUIT_COOL_MS || 45000) || 45000;
    console.log(
      JSON.stringify({
        step: "retry_cool_after_catalog_circuit",
        coolMs,
        softRate: Math.round(softRate * 1000) / 1000,
      })
    );
    await new Promise((r) => setTimeout(r, coolMs));
    if (CONFIRM) {
      await patchRun(runRef, FieldValue, { circuitOpenThisWindow: false }, false);
    }
  }

  const errors = await listErrorObservations(db, admin, LIMIT, typePlan);

  if (!errors.length) {
    console.log("No market_observations with status=error.");
    if (CONFIRM) {
      await patchRun(runRef, FieldValue, { retryLeft: 0, lastError: null }, false);
    }
    console.log(JSON.stringify({ retryOk, retryFail, retryLeft: 0, attempted: 0 }, null, 2));
    return;
  }

  // Ensure run doc exists for counters
  await loadOrCreateRun(db, periodId, FieldValue, { dryRun: !CONFIRM });

  const session = new BrickLinkSession({
    headless: HEADLESS,
    pauseMs: process.env.BL_PAUSE_MS ? undefined : [1500, 3000],
  });
  let attempted = 0;
  let chunkOk = 0;
  let chunkFail = 0;
  let lastError = null;

  try {
    await session.warmUp();

    for (const row of errors) {
      if (Date.now() >= deadlineMs) break;
      if (session.isCircuitOpen()) {
        lastError = "circuit_open_stop_window";
        console.log(
          JSON.stringify({
            step: "retry_stop_circuit",
            circuitTrips: session.circuitTrips,
          })
        );
        break;
      }
      attempted += 1;

      let setNo = row.setNo;
      let fetchType = row.itemType || "SET";
      if (row.catalogItemId) {
        const cat = await db.collection("catalog_items").doc(row.catalogItemId).get();
        if (cat.exists) {
          const fetch = resolveBrickLinkFetch(cat.data() || {});
          if (fetch.skip) {
            chunkFail += 1;
            retryFail += 1;
            lastError = fetch.reason || "skip_no_bl_item";
            console.error(`SKIP retry ${row.catalogItemId}: ${lastError}`);
            continue;
          }
          if (fetch.itemNumber) {
            setNo = fetch.itemNumber;
            fetchType = fetch.itemType || fetchType;
          }
        }
      }
      if (!setNo) {
        chunkFail += 1;
        retryFail += 1;
        lastError = `missing_setNo:${row.catalogItemId}`;
        console.error(`SKIP retry ${row.catalogItemId}: no setNo`);
        continue;
      }

      console.log(`… retry ${fetchType} ${setNo} → ${row.catalogItemId}`);
      let scrape;
      try {
        // Deep fetch (no catalogPass): WAF/empty recovery belongs here — catalog is shallow.
        scrape = await session.fetchSet(setNo, {
          itemType: fetchType,
        });
      } catch (e) {
        lastError = String(e?.message || e);
        if (/circuit_open/i.test(lastError)) {
          console.log(JSON.stringify({ step: "retry_stop_circuit", error: lastError }));
          break;
        }
        console.error(`FAIL retry ${setNo}:`, lastError);
        chunkFail += 1;
        retryFail += 1;
        if (CONFIRM) {
          await writeObservationFromParse(
            db,
            admin.firestore,
            {
              catalogItemId: row.catalogItemId,
              itemType: row.itemType,
              setNo,
              parsed: { ok: false, error: lastError },
              method: HTTP_METHOD,
              errorTag: "exception",
            },
            { writeBif: false, dryRun: false }
          );
        }
        continue;
      }

      if (!scrape.parsed?.ok) {
        lastError = scrape.parsed?.error || scrape.waitError || "parse_failed";
        console.error(`FAIL retry ${setNo}:`, lastError);
        chunkFail += 1;
        retryFail += 1;
        if (CONFIRM) {
          await writeObservationFromParse(
            db,
            admin.firestore,
            {
              catalogItemId: row.catalogItemId,
              itemType: row.itemType,
              setNo,
              parsed: scrape.parsed || { ok: false, error: lastError },
              method: scrape.method,
              errorTag: scrape.errorTag || null,
            },
            { writeBif: false, dryRun: false }
          );
        }
        continue;
      }

      const write = await writeObservationFromParse(
        db,
        admin.firestore,
        {
          catalogItemId: row.catalogItemId,
          itemType: row.itemType,
          setNo,
          parsed: scrape.parsed,
          method: scrape.method,
        },
        { writeBif: !NO_BIF, dryRun: !CONFIRM }
      );

      chunkOk += 1;
      retryOk += 1;
      console.log(
        JSON.stringify({
          setNo,
          catalogItemId: row.catalogItemId,
          ok: true,
          empty: !!scrape.parsed.empty,
          status: scrape.parsed.empty ? "no_data" : "ok",
          dryRun: write.dryRun,
        })
      );

      if (CONFIRM) {
        await patchRun(
          runRef,
          FieldValue,
          { retryOk, retryFail, lastError: null },
          false
        );
      }
    }
  } finally {
    await session.close();
  }

  // Remaining errors after this pass (existence only — avoid a second full scan).
  const leftSnap = await db
    .collection("market_observations")
    .where("source", "==", "bricklink")
    .where("status", "==", "error")
    .limit(1)
    .get();
  const retryLeft = leftSnap.empty ? 0 : 500;

  if (CONFIRM) {
    await patchRun(
      runRef,
      FieldValue,
      {
        retryOk,
        retryFail,
        retryLeft,
        lastError,
        circuitOpenThisWindow: false,
      },
      false
    );
  }

  const summary = {
    periodId,
    attempted,
    chunkOk,
    chunkFail,
    retryOk,
    retryFail,
    retryLeft,
    circuitTrips: session.circuitTrips || 0,
    circuitOpen: session.isCircuitOpen(),
    elapsedSec: Math.round((Date.now() - startedMs) / 1000),
    dryRun: !CONFIRM,
  };
  console.log("\n--- retry-errors summary ---");
  console.log(JSON.stringify(summary, null, 2));
  writeIngestArtifact("retry", summary);
  if (!CONFIRM) console.log("Dry-run only. Re-run with --confirm to write Firestore.");
  if (chunkFail > 0 && chunkOk === 0 && attempted > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
