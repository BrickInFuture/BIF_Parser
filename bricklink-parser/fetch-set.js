/**
 * BrickLink Price Guide CLI (NO Store API).
 *
 * One Chromium session → one or many sets.
 *
 *   npm run parse:bricklink -- 77256-1
 *   npm run parse:bricklink -- 77256-1,75192-1 --save-html
 *   npm run parse:bricklink -- 77256-1 --headed
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { BrickLinkSession, DEFAULT_TIMEOUT_MS } = require("./session");
const { normalizeSetNo, parseCatalogPgHtml } = require("./parseHtml");

const OUT_DIR = path.join(__dirname, "out");
const HEADLESS = !process.argv.includes("--headed");
const SAVE_HTML = process.argv.includes("--save-html");

function parseSetArgs(argv) {
  const raw = argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);
  // argv[2] is first user arg when run via node script.js
  const first = process.argv[2] && !String(process.argv[2]).startsWith("--") ? process.argv[2] : "77256-1";
  return String(first)
    .split(",")
    .map((s) => normalizeSetNo(s))
    .filter(Boolean);
}

function printSummary(result) {
  console.log(
    `  ${result.setNo}: ok=${result.parsed?.ok} soldNew=${result.parsed?.soldNew?.qtyAvgUsd} soldUsed=${result.parsed?.soldUsed?.qtyAvgUsd} stockNew=${result.parsed?.stockNew?.qtyAvgUsd}`
  );
}

async function main() {
  const setNos = parseSetArgs(process.argv);
  if (!setNos.length) {
    console.error("Usage: node scripts/bricklink-parser/fetch-set.js <setNo[,setNo...]> [--headed] [--save-html]");
    process.exit(1);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    JSON.stringify(
      {
        step: "bricklink_batch_start",
        setNos,
        headless: HEADLESS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        sessionReuse: true,
      },
      null,
      2
    )
  );

  const session = new BrickLinkSession({ headless: HEADLESS });
  const results = [];
  try {
    await session.warmUp();
    for (const setNo of setNos) {
      const result = await session.fetchSet(setNo, { returnHtml: SAVE_HTML });
      if (SAVE_HTML && result.html) {
        const htmlPath = path.join(OUT_DIR, `bl-pg-${setNo.replace(/[^\w.-]/g, "_")}.html`);
        fs.writeFileSync(htmlPath, result.html, "utf8");
        result.htmlSaved = htmlPath;
      }
      delete result.html;

      const reportPath = path.join(OUT_DIR, `report-${setNo.replace(/[^\w.-]/g, "_")}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf8");
      result.reportPath = reportPath;
      results.push(result);
      printSummary(result);
    }
  } finally {
    await session.close();
  }

  const okCount = results.filter((r) => r.parsed?.ok).length;
  console.log(`\n--- batch summary: ${okCount}/${results.length} ok ---`);
  if (okCount < results.length) process.exitCode = 2;
  else console.log("PARSE OK");
}

module.exports = {
  BrickLinkSession,
  parseCatalogPgHtml,
  normalizeSetNo,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("PARSER ERROR:", err && err.message ? err.message : err);
    process.exit(1);
  });
}
