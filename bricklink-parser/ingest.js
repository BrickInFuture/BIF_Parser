/**
 * Ingest BrickLink Price Guide into Firestore (explicit set list, session reuse).
 *
 *   npm run ingest:bricklink -- 77256-1 --confirm
 *   npm run ingest:bricklink -- 77256-1,75192-1 --confirm
 *
 * Catalog-wide (checkpointed): npm run ingest:bricklink:catalog -- --confirm --limit=500
 *
 * On scrape fail: observation error only — last-good bif_prices is never overwritten.
 */
"use strict";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { BrickLinkSession } = require("./session");
const { normalizeSetNo } = require("./parseHtml");
const { writeObservationFromParse } = require("./observationWriter");
const { resolveBrickLinkFetch } = require("./blUrls");

const CONFIRM = process.argv.includes("--confirm");
const HEADLESS = !process.argv.includes("--headed");
const NO_BIF = process.argv.includes("--no-bif");

const { admin, db } = initFirebaseAdmin();

function parseSetArgs() {
  const first = process.argv.slice(2).find((a) => !String(a).startsWith("--"));
  if (!first) return ["77256-1"];
  return String(first)
    .split(",")
    .map((s) => normalizeSetNo(s))
    .filter(Boolean);
}

async function resolveCatalogItem(setNo) {
  const candidates = [
    `SET_${setNo}`,
    `MINIFIG_${setNo}`,
    `GEAR_${String(setNo).replace(/-1$/i, "")}`,
    `GEAR_${setNo}`,
  ];
  for (const docId of candidates) {
    const byId = await db.collection("catalog_items").doc(docId).get();
    if (byId.exists) {
      const d = byId.data() || {};
      return {
        catalogItemId: byId.id,
        itemType: String(d.itemType || "SET").toUpperCase(),
        itemNumber: d.itemNumber || setNo,
        catalog: d,
      };
    }
  }

  const q = await db.collection("catalog_items").where("itemNumber", "==", setNo).limit(1).get();
  if (!q.empty) {
    const doc = q.docs[0];
    const d = doc.data() || {};
    return {
      catalogItemId: doc.id,
      itemType: String(d.itemType || "SET").toUpperCase(),
      itemNumber: d.itemNumber || setNo,
      catalog: d,
    };
  }

  return null;
}

async function main() {
  const setNos = parseSetArgs();
  console.log(
    JSON.stringify(
      {
        step: "bricklink_ingest_start",
        setNos,
        confirm: CONFIRM,
        writeBif: !NO_BIF,
        headless: HEADLESS,
      },
      null,
      2
    )
  );

  const session = new BrickLinkSession({ headless: HEADLESS });
  const summary = [];

  try {
    await session.warmUp();

    for (const setNo of setNos) {
      const cat = await resolveCatalogItem(setNo);
      if (!cat) {
        console.error(`SKIP ${setNo}: not found in catalog_items`);
        summary.push({ setNo, ok: false, error: "catalog_item_missing" });
        continue;
      }

      const fetch = resolveBrickLinkFetch(cat.catalog || cat);
      if (fetch.skip) {
        console.error(`SKIP ${setNo}: ${fetch.reason}`);
        summary.push({ setNo, catalogItemId: cat.catalogItemId, ok: false, error: fetch.reason });
        continue;
      }
      const fetchNo = fetch.itemNumber || setNo;
      const fetchType = fetch.itemType || cat.itemType || "SET";
      console.log(`… scrape ${fetchType} ${fetchNo} → ${cat.catalogItemId}`);
      const scrape = await session.fetchSet(fetchNo, { itemType: fetchType });
      if (!scrape.parsed?.ok) {
        console.error(`FAIL ${setNo}:`, scrape.parsed?.error || scrape.waitError);
        summary.push({
          setNo,
          catalogItemId: cat.catalogItemId,
          ok: false,
          error: scrape.parsed?.error || scrape.waitError,
        });
        // Observation error only — do not overwrite last-good bif
        if (CONFIRM) {
          await writeObservationFromParse(
            db,
            admin.firestore,
            {
              catalogItemId: cat.catalogItemId,
              itemType: cat.itemType,
              setNo: fetchNo,
              parsed: scrape.parsed || { ok: false, error: scrape.waitError },
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
          catalogItemId: cat.catalogItemId,
          itemType: cat.itemType,
          setNo: fetchNo,
          parsed: scrape.parsed,
          method: scrape.method,
        },
        { writeBif: !NO_BIF, dryRun: !CONFIRM }
      );

      const row = {
        setNo,
        catalogItemId: cat.catalogItemId,
        ok: true,
        soldNew: scrape.parsed.soldNew?.qtyAvgUsd,
        soldUsed: scrape.parsed.soldUsed?.qtyAvgUsd,
        bifTypicalNew: write.bifTypicalNew ?? write.bifDoc?.new?.typicalUsd,
        bifTypicalUsed: write.bifTypicalUsed ?? write.bifDoc?.used?.typicalUsd,
        obsId: write.obsId,
        periodId: write.periodId,
        dryRun: write.dryRun,
      };
      summary.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    await session.close();
  }

  console.log("\n--- ingest summary ---");
  console.log(JSON.stringify(summary, null, 2));
  if (!CONFIRM) console.log("Dry-run only. Re-run with --confirm to write Firestore.");
  const failed = summary.some((s) => !s.ok);
  if (failed) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
