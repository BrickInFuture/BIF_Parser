/**
 * Pure CatalogPG.asp HTML → sold/stock aggregates (no browser).
 *
 * Distinguishes:
 * - AWS WAF / soft-block pages (blocked) — including large "Page Not Found" junk shells
 * - Real Price Guide with numbers (ok)
 * - Real Price Guide with no sales/listings (ok + empty / no_data) — NOT an error
 * - PG chrome present but blocks unmapped → parse error (retry), NOT empty
 */
"use strict";

const cheerio = require("cheerio");
const { formatPeriodId, utcYearMonth } = require("./gapLedger");

function normalizeSetNo(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  return s.includes("-") ? s : `${s}-1`;
}

function parseMoney(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/US\s*\$/gi, "")
    .replace(/USD/gi, "")
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function parseIntSafe(raw) {
  const n = Number(String(raw || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function emptyAgg() {
  return {
    count: 0,
    totalQty: 0,
    minUsd: null,
    maxUsd: null,
    avgUsd: null,
    qtyAvgUsd: null,
    medianUsd: null,
  };
}

function extractHtmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

function toPlainText(chunk) {
  return String(chunk || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseStatsBlock(chunk) {
  const agg = emptyAgg();
  if (!chunk) return agg;

  const plain = toPlainText(chunk);

  const pickCount = (label) => {
    const m = plain.match(new RegExp(`${label}\\s*:\\s*([\\d,]+)`, "i"));
    return m ? m[1].trim() : null;
  };
  // Money: "Min Price: US $9.09" | "US$9.09" | "$9.09" | "9.09"
  const pickPrice = (label) => {
    const m = plain.match(
      new RegExp(`${label}\\s*:\\s*(?:US\\s*)?\\$?\\s*([\\d,.]+)`, "i")
    );
    return m ? m[1].trim() : null;
  };

  agg.count = parseIntSafe(pickCount("Times Sold") ?? pickCount("Total Lots")) || 0;
  agg.totalQty = parseIntSafe(pickCount("Total Qty")) || 0;
  agg.minUsd = parseMoney(pickPrice("Min Price"));
  agg.maxUsd = parseMoney(pickPrice("Max Price"));
  agg.avgUsd = parseMoney(pickPrice("Avg Price"));
  agg.qtyAvgUsd = parseMoney(pickPrice("Qty Avg Price"));
  agg.medianUsd = null;
  return agg;
}

function hasUsefulAgg(a) {
  return (
    a &&
    (a.avgUsd != null ||
      a.qtyAvgUsd != null ||
      a.minUsd != null ||
      (a.count > 0 && a.maxUsd != null))
  );
}

/** Lots/qty parsed but unit prices missing → broken money parse, NOT empty market. */
function hasCountsWithoutPrices(a) {
  if (!a) return false;
  if (a.explicitNoPrice) return false; // market shows real "N/A" cells, not a parse miss
  const hasCount = (Number(a.count) || 0) > 0 || (Number(a.totalQty) || 0) > 0;
  if (!hasCount) return false;
  return a.avgUsd == null && a.qtyAvgUsd == null && a.minUsd == null && a.maxUsd == null;
}

/** Count present, but market's own price cells are explicit "N/A"/"-" (not a parse bug). */
function hasExplicitNoPriceCount(a) {
  if (!a || !a.explicitNoPrice) return false;
  return (Number(a.count) || 0) > 0 || (Number(a.totalQty) || 0) > 0;
}

/**
 * Structural (DOM-based) summary reader — replaces the old "cut text with a regex window"
 * approach for the common case. market's price tables are old-school nested <table> markup;
 * a fixed character-window regex can cut a block off right after a label and before its value
 * lands in a sibling <td>, which silently drops the price while the label/count survive.
 * Reading the actual label <td> → next <td> pairing sidesteps that entirely, regardless of
 * how deeply the table is nested inside other layout tables on the page.
 */
const SUMMARY_LABELS = [
  ["timesSold", /^Times\s*Sold$/i],
  ["totalLots", /^Total\s*Lots$/i],
  ["totalQty", /^Total\s*Qty$/i],
  ["minPrice", /^Min\s*Price$/i],
  ["avgPrice", /^Avg\s*Price$/i],
  ["qtyAvgPrice", /^Qty\s*Avg\s*Price$/i],
  ["maxPrice", /^Max\s*Price$/i],
];

function cleanCellText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summaryLabelKey(rawText) {
  const t = cleanCellText(rawText).replace(/:\s*$/, "");
  const hit = SUMMARY_LABELS.find(([, re]) => re.test(t));
  return hit ? hit[0] : null;
}

/** "N/A" / "-" / blank cell — market explicitly has no computable price, not a parse miss. */
function isExplicitNoPricePlaceholder(rawValue) {
  if (rawValue == null) return false;
  const t = cleanCellText(rawValue).replace(/^US\s*\$?\s*/i, "").trim();
  return t === "" || /^(n\/a|na|-{1,2}|—)$/i.test(t);
}

/** Every label/value <td> pair on the page, in document order, regardless of table nesting. */
function extractStructuredRows(html) {
  const $ = cheerio.load(String(html || ""));
  const rows = [];
  $("tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length < 2) return;
    const key = summaryLabelKey($(tds[0]).text());
    if (!key) return;
    rows.push({ key, value: cleanCellText($(tds[1]).text()) });
  });
  return rows;
}

/** Group label rows into per-table blocks; a new block starts at each "header" row. */
function groupRowsIntoBlocks(rows) {
  const blocks = [];
  let current = null;
  for (const row of rows) {
    if (row.key === "timesSold" || row.key === "totalLots") {
      current = { headerKey: row.key, rows: [row] };
      blocks.push(current);
    } else if (current) {
      current.rows.push(row);
    }
  }
  return blocks;
}

function aggFromStructuredBlock(block) {
  const agg = emptyAgg();
  if (!block) return agg;
  const get = (key) => {
    const hit = block.rows.find((r) => r.key === key);
    return hit ? hit.value : null;
  };
  agg.count = parseIntSafe(get("timesSold") ?? get("totalLots")) || 0;
  agg.totalQty = parseIntSafe(get("totalQty")) || 0;
  agg.minUsd = parseMoney(get("minPrice"));
  agg.maxUsd = parseMoney(get("maxPrice"));
  agg.avgUsd = parseMoney(get("avgPrice"));
  agg.qtyAvgUsd = parseMoney(get("qtyAvgPrice"));
  agg.medianUsd = null;

  // All four price cells found in the DOM and each is an explicit "N/A"/"-" placeholder →
  // market itself has no computable price for this row (real state, not a parse miss).
  const priceCells = ["minPrice", "avgPrice", "qtyAvgPrice", "maxPrice"].map((k) => get(k));
  agg.explicitNoPrice =
    priceCells.every((v) => v != null) && priceCells.every(isExplicitNoPricePlaceholder);
  return agg;
}

/** market cell that is just "Unavailable" (no Times Sold / Total Lots table). */
function cellLooksUnavailable(text) {
  const t = cleanCellText(text);
  if (!t) return false;
  if (/Times\s*Sold|Total\s*Lots/i.test(t)) return false;
  return /^unavailable$/i.test(t) || /^n\/?a$/i.test(t);
}

/**
 * Parse one summary-grid <td>: sold block, stock block, or empty/Unavailable.
 * Real catalogPG layout is four columns: sold New | sold Used | stock New | stock Used.
 */
function aggFromSummaryCellHtml(cellHtml) {
  const html = String(cellHtml || "");
  const plain = toPlainText(html);
  if (cellLooksUnavailable(plain)) {
    return { kind: null, agg: emptyAgg(), unavailable: true };
  }
  let rows = [];
  try {
    rows = extractStructuredRows(html);
  } catch (e) {
    rows = [];
  }
  const blocks = groupRowsIntoBlocks(rows);
  const sold = blocks.filter((b) => b.headerKey === "timesSold").map(aggFromStructuredBlock);
  const stock = blocks.filter((b) => b.headerKey === "totalLots").map(aggFromStructuredBlock);
  if (sold[0] && (hasUsefulAgg(sold[0]) || hasExplicitNoPriceCount(sold[0]) || (sold[0].count || 0) > 0)) {
    return { kind: "sold", agg: sold[0], unavailable: false };
  }
  if (stock[0] && (hasUsefulAgg(stock[0]) || hasExplicitNoPriceCount(stock[0]) || (stock[0].count || 0) > 0)) {
    return { kind: "stock", agg: stock[0], unavailable: false };
  }
  const { soldBlocks, stockBlocks } = extractAggBlocks(html);
  if (soldBlocks[0]) {
    const agg = parseStatsBlock(soldBlocks[0]);
    if (hasUsefulAgg(agg) || (agg.count || 0) > 0) return { kind: "sold", agg, unavailable: false };
  }
  if (stockBlocks[0]) {
    const agg = parseStatsBlock(stockBlocks[0]);
    if (hasUsefulAgg(agg) || (agg.count || 0) > 0) return { kind: "stock", agg, unavailable: false };
  }
  return { kind: null, agg: emptyAgg(), unavailable: false };
}

/**
 * Prefer column position over "first Times Sold = New". When New sold is Unavailable,
 * market omits that Times Sold table — positional [0]/[1] would wrongly put Used into soldNew.
 */
function parseSummaryQuadColumns(html) {
  let $;
  try {
    $ = cheerio.load(String(html || ""));
  } catch (e) {
    return null;
  }

  let headerTr = null;
  $("tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length !== 4) return;
    const labels = [];
    tds.each((__, td) => {
      labels.push(cleanCellText($(td).text()).replace(/\s+/g, " "));
    });
    const isNew = (s) => /^new$/i.test(String(s || "").trim());
    const isUsed = (s) => /^used$/i.test(String(s || "").trim());
    if (isNew(labels[0]) && isUsed(labels[1]) && isNew(labels[2]) && isUsed(labels[3])) {
      headerTr = tr;
      return false;
    }
  });
  if (!headerTr) return null;

  const dataTr = $(headerTr)
    .nextAll("tr")
    .filter((_, tr) => $(tr).children("td").length === 4)
    .first();
  if (!dataTr.length) return null;

  const cells = dataTr.children("td");
  if (cells.length < 4) return null;

  const parsed = [0, 1, 2, 3].map((i) => {
    const td = cells.eq(i);
    return aggFromSummaryCellHtml($.html(td));
  });

  const soldNew = parsed[0].kind === "sold" ? parsed[0].agg : emptyAgg();
  const soldUsed = parsed[1].kind === "sold" ? parsed[1].agg : emptyAgg();
  const stockNew = parsed[2].kind === "stock" ? parsed[2].agg : emptyAgg();
  const stockUsed = parsed[3].kind === "stock" ? parsed[3].agg : emptyAgg();

  if (
    !hasUsefulAgg(soldNew) &&
    !hasUsefulAgg(soldUsed) &&
    !hasUsefulAgg(stockNew) &&
    !hasUsefulAgg(stockUsed) &&
    !hasExplicitNoPriceCount(soldNew) &&
    !hasExplicitNoPriceCount(soldUsed) &&
    !hasExplicitNoPriceCount(stockNew) &&
    !hasExplicitNoPriceCount(stockUsed) &&
    !(parsed[0].unavailable || parsed[1].unavailable)
  ) {
    return null;
  }

  return { soldNew, soldUsed, stockNew, stockUsed, via: "quad_columns" };
}

/**
 * Map ordered sold/stock blocks to New/Used without assuming a missing New column
 * still occupies index 0. When the sales half shows Unavailable before the only
 * Times Sold block, that block is Used.
 */
function mapSoldStockBlocksToSides(soldBlocks, stockBlocks, contextHtml) {
  const ctx = String(contextHtml || "");
  const sold = (soldBlocks || []).map((b) => (typeof b === "string" ? parseStatsBlock(b) : b));
  const stock = (stockBlocks || []).map((b) => (typeof b === "string" ? parseStatsBlock(b) : b));

  let soldNew = emptyAgg();
  let soldUsed = emptyAgg();
  const usedSoldFirst = /Unavailable[\s\S]{0,2500}?Times\s*Sold/i.test(ctx);
  if (sold.length >= 2) {
    if (usedSoldFirst) {
      // New column missing: first Times Sold is Used; do not treat [0] as New.
      soldUsed = sold[0] || emptyAgg();
      soldNew = emptyAgg();
    } else {
      soldNew = sold[0] || emptyAgg();
      soldUsed = sold[1] || emptyAgg();
    }
  } else if (sold.length === 1) {
    const only = sold[0] || emptyAgg();
    if (usedSoldFirst) soldUsed = only;
    else soldNew = only;
  }

  let stockNew = emptyAgg();
  let stockUsed = emptyAgg();
  if (stock.length >= 2) {
    stockNew = stock[0] || emptyAgg();
    stockUsed = stock[1] || emptyAgg();
  } else if (stock.length === 1) {
    const only = stock[0] || emptyAgg();
    const usedOnlyStock =
      /Current\s*Items\s*for\s*Sale[\s\S]{0,4000}?Unavailable[\s\S]{0,2500}?Total\s*Lots/i.test(ctx);
    if (usedOnlyStock) stockUsed = only;
    else stockNew = only;
  }

  return { soldNew, soldUsed, stockNew, stockUsed };
}

/**
 * Structured sold/stock aggregates for the whole page, or null if the page has no
 * table-based summary rows at all (falls back to the legacy plaintext approach).
 * Prefers the fixed 4-column New/Used grid; falls back to block order with
 * Unavailable-aware remapping when a side is missing.
 */
function parseStructuredSummary(html) {
  const quad = parseSummaryQuadColumns(html);
  if (quad) {
    return {
      soldNew: quad.soldNew,
      soldUsed: quad.soldUsed,
      stockNew: quad.stockNew,
      stockUsed: quad.stockUsed,
    };
  }

  let rows;
  try {
    rows = extractStructuredRows(html);
  } catch (e) {
    return null;
  }
  if (!rows.length) return null;

  const blocks = groupRowsIntoBlocks(rows);
  const soldBlocks = blocks.filter((b) => b.headerKey === "timesSold").map(aggFromStructuredBlock);
  const stockBlocks = blocks.filter((b) => b.headerKey === "totalLots").map(aggFromStructuredBlock);
  if (!soldBlocks.length && !stockBlocks.length) return null;

  // Summary tables come first; monthly detail Times Sold further down must not shift indices.
  // Take at most the first two sold + first two stock from the page start (summary zone).
  const summaryHtml = extractSummaryHtml(html) || html;
  let summaryRows;
  try {
    summaryRows = extractStructuredRows(summaryHtml);
  } catch (e) {
    summaryRows = rows;
  }
  const summaryBlocks = groupRowsIntoBlocks(summaryRows);
  const summarySold = summaryBlocks
    .filter((b) => b.headerKey === "timesSold")
    .map(aggFromStructuredBlock)
    .slice(0, 2);
  const summaryStock = summaryBlocks
    .filter((b) => b.headerKey === "totalLots")
    .map(aggFromStructuredBlock)
    .slice(0, 2);
  const useSold = summarySold.length ? summarySold : soldBlocks.slice(0, 2);
  const useStock = summaryStock.length ? summaryStock : stockBlocks.slice(0, 2);

  return mapSoldStockBlocksToSides(useSold, useStock, summaryHtml);
}

/** Prefer whichever parse (structured vs legacy plaintext) actually found usable data. */
function pickBetterAgg(structured, legacy) {
  if (!structured) return legacy;
  if (hasUsefulAgg(structured)) return structured;
  if (!hasUsefulAgg(legacy) && ((structured.count || 0) > 0 || (structured.totalQty || 0) > 0)) {
    return structured;
  }
  return legacy;
}

function hasPriceGuideContent(html) {
  const raw = String(html || "");
  // Catalog miss pages are not Price Guide bodies (even when large).
  if (hasNoItemsFoundMarker(raw)) return false;
  return (
    /Last\s*6\s*Months\s*Sales/i.test(raw) ||
    /Current\s*Items\s*for\s*Sale/i.test(raw) ||
    /Times\s*Sold\s*:/i.test(raw) ||
    /Total\s*Lots\s*:/i.test(raw) ||
    looksEmptyPriceGuide(raw)
  );
}

function hasPageNotFoundMarker(title, raw) {
  return (
    /Page\s+Not\s+Found/i.test(String(title || "")) ||
    /Page\s+Not\s+Found/i.test(String(raw || "").slice(0, 4000))
  );
}

/** Catalog miss (wrong id / no listing) — often a large shell with bathroom.gif. */
function hasNoItemsFoundMarker(raw) {
  return /No\s+Item\(s\)\s+were\s+found/i.test(String(raw || ""));
}

/**
 * Soft-block / anti-bot junk shell (Oops / BrickLink Error / large PNF without PG chrome).
 * Detect ASAP so waitForPriceGuide does not burn ~12–24s.
 * Catalog misses ("No Item(s) were found") are NOT soft-blocks — they are empty markets.
 */
function looksSoftBlockShell(title, raw) {
  const t = String(title || "");
  const html = String(raw || "");
  if (!html) return false;
  if (hasPriceGuideContent(html)) return false;
  if (hasNoItemsFoundMarker(html)) return false;
  if (/Oops/i.test(t) || /BrickLink\s+Error/i.test(t) || /Sorry!\s*\|\s*BrickLink/i.test(t)) {
    return html.length >= 4000;
  }
  // Large PNF without explicit "No Item(s)" copy can still be junk soft-block.
  if (hasPageNotFoundMarker(t, html) && html.length >= 12000) return true;
  return false;
}

/**
 * True dead catalog / missing item — PNF or "No Item(s) were found" without PG chrome.
 * Size does not matter: live BL miss pages are large shells with bathroom.gif.
 */
function isDeadCatalogPage(raw, title) {
  if (hasPriceGuideContent(raw)) return false;
  if (hasNoItemsFoundMarker(raw)) return true;
  if (!hasPageNotFoundMarker(title, raw)) return false;
  // Small classic PNF; large PNF without "No Item(s)" stays soft-block via isWafChallengePage.
  return String(raw || "").length < 12000;
}

/**
 * True for WAF / soft-block pages (not a usable Price Guide body).
 */
function isWafChallengePage(html) {
  const raw = String(html || "");
  if (!raw) return true;

  const title = extractHtmlTitle(raw);

  // Catalog miss is never anti-bot — treat as empty market upstream.
  if (hasNoItemsFoundMarker(raw) && !hasPriceGuideContent(raw)) {
    return false;
  }

  // Large "Page Not Found" without PG chrome and without "No Item(s)" → soft-block junk
  if (hasPageNotFoundMarker(title, raw) && raw.length >= 12000 && !hasPriceGuideContent(raw)) {
    return true;
  }

  // Real challenge UI — not the footer awswaf.com script on every BL page.
  const hasChallengeUi =
    /id=["']challenge-container["']/i.test(raw) ||
    /AwsWafIntegration\.(getToken|forceRefreshToken|checkForceRefresh)/i.test(raw) ||
    /\bcaptcha\b/i.test(raw) ||
    /Access\s*Denied/i.test(raw) ||
    /Request\s+blocked/i.test(raw);

  if (hasChallengeUi) {
    // Tiny interstitial → blocked
    if (raw.length < 8000) return true;
    // Large page with challenge hooks is OK only if real PG *content* is present
    // (title alone must NOT clear blocked).
    if (hasPriceGuideContent(raw)) return false;
    return true;
  }

  // Soft-block: large-ish page with Price Guide title but no sales/listings chrome
  const titleOnly =
    /Price Guide\s*-\s*Set/i.test(raw) ||
    /Price Guide\s*-\s*Minifig/i.test(raw) ||
    /BrickLink\s+Price\s+Guide/i.test(raw);
  if (titleOnly && raw.length > 8000 && !hasPriceGuideContent(raw)) {
    return true;
  }

  // Oops / market Error / Sorry! shells — same detector as live poll in session.js.
  // Without this, parseCatalogPgHtml falls through to "No price aggregates" (mis-tag).
  if (looksSoftBlockShell(title, raw)) return true;

  return false;
}

/**
 * True when a stored observation errorTag/error string means anti-bot soft-block,
 * including historically mis-tagged Oops pages labeled no_aggregates.
 */
function errorLooksLikeSoftBlock(tag, err) {
  const t = String(tag || "");
  if (t === "soft_blocked" || t === "waf_blocked") return true;
  const e = String(err || "");
  if (/soft.?block/i.test(e)) return true;
  if (/Oops/i.test(e) || /title=Oops/i.test(e)) return true;
  if (/Sorry!\s*\|\s*BrickLink/i.test(e)) return true;
  if (/BrickLink\s+Error/i.test(e)) return true;
  return false;
}

/**
 * Real Price Guide body chrome (not title / catalogPG.asp alone).
 */
function isPriceGuideShell(html) {
  return hasPriceGuideContent(html);
}

function looksEmptyPriceGuide(html) {
  const raw = String(html || "");
  if (hasNoItemsFoundMarker(raw)) return true;
  const plain = toPlainText(raw).toLowerCase();

  return (
    /there are no (completed )?sales/i.test(plain) ||
    /no records?\s*(found|available)/i.test(plain) ||
    /nothing (found|to (show|display))/i.test(plain) ||
    /not enough data/i.test(plain) ||
    (/times sold:\s*0/.test(plain) && !/\$\s*\d/.test(plain) && !/us\s*\$\s*\d/.test(plain))
  );
}

function hasUnmappedPriceMarkers(html) {
  const raw = String(html || "");
  return (
    /Avg\s*Price/i.test(raw) ||
    /Qty\s*Avg\s*Price/i.test(raw) ||
    (/Times\s*Sold\s*:/i.test(raw) && /Max\s*Price/i.test(raw)) ||
    (/Total\s*Lots\s*:/i.test(raw) && /Max\s*Price/i.test(raw))
  );
}

/** Slice summary grid; ignore monthly detail tables below when possible. */
function extractSummaryHtml(raw) {
  const start = String(raw || "").search(/Last\s*6\s*Months\s*Sales/i);
  if (start < 0) {
    const alt = String(raw || "").search(/Times\s*Sold\s*:|Total\s*Lots\s*:/i);
    if (alt < 0) return null;
    return String(raw).slice(alt, alt + 20000);
  }
  const after = String(raw).slice(start);
  // Cut before the first real month header ("July 2026" / "July&nbsp;2026").
  // Always cut when found — including short fixtures — so monthly Times Sold
  // never shift summary New/Used indices (Used-only + later months looked like New+Used).
  const monthCut = after.search(MONTH_HEADER_RE);
  if (monthCut >= 0) return after.slice(0, monthCut);
  return after.slice(0, 20000);
}

const MONTH_NAME_TO_NUM = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

const MONTH_NAMES_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December";
/** На живой BL между месяцем и годом часто `August&nbsp;2026`, не пробел. */
const MONTH_GAP = "(?:\\s|&nbsp;|&#160;)+";
const MONTH_HEADER_RE = new RegExp(
  `\\b(${MONTH_NAMES_PATTERN})${MONTH_GAP}(20\\d{2})\\b`,
  "gi"
);

/** «August 2026» на market → periodId UTC (2026-08). */
function monthLabelToPeriodId(monthName, yearStr) {
  const m = MONTH_NAME_TO_NUM[String(monthName || "").toLowerCase()];
  const y = Number(yearStr);
  if (!m || !Number.isFinite(y) || y < 1990 || y > 2100) return null;
  return formatPeriodId(y, m);
}

function parseStatsFromMonthCell(cellHtml) {
  const cell = String(cellHtml || "");
  const hrPos = cell.lastIndexOf("<hr");
  const tail = hrPos >= 0 ? cell.slice(hrPos) : cell;
  const structured = parseStructuredSummary(tail);
  if (structured && hasUsefulAgg(structured.soldNew)) return structured.soldNew;
  if (structured && hasUsefulAgg(structured.soldUsed)) return structured.soldUsed;
  const { soldBlocks } = extractAggBlocks(tail);
  if (soldBlocks[0]) return parseStatsBlock(soldBlocks[0]);
  const plain = parseStatsBlock(toPlainText(tail));
  return plain;
}

/** Границы <td> ячейки, в которой лежит заголовок месяца. */
function findMonthCellHtml(raw, headerIndex) {
  const before = raw.slice(Math.max(0, headerIndex - 500), headerIndex);
  const relTd = before.lastIndexOf("<td");
  if (relTd < 0) return null;
  const start = headerIndex - (before.length - relTd);
  const after = raw.slice(headerIndex);
  const relEnd = after.indexOf("</td>");
  if (relEnd < 0) return null;
  return raw.slice(start, headerIndex + relEnd + 5);
}

/**
 * @param {"new"|"used"|null} sideHint — when known (column on live BL), write that side only.
 */
function mergeMonthSide(row, agg, sideHint = null) {
  if (!hasUsefulAgg(agg) && !hasExplicitNoPriceCount(agg)) return row;
  if (sideHint === "used") {
    if (!rowHasSoldSignal({ soldNew: emptyAgg(), soldUsed: row.soldUsed })) row.soldUsed = agg;
    return row;
  }
  if (sideHint === "new") {
    if (!rowHasSoldSignal({ soldNew: row.soldNew, soldUsed: emptyAgg() })) row.soldNew = agg;
    return row;
  }
  // Legacy fixtures: first lone block → New, second → Used.
  if (!rowHasSoldSignal({ soldNew: row.soldNew, soldUsed: emptyAgg() })) {
    row.soldNew = agg;
  } else if (!rowHasSoldSignal({ soldNew: emptyAgg(), soldUsed: row.soldUsed })) {
    row.soldUsed = agg;
  }
  return row;
}

/**
 * Live catalogPG monthly history sits in two vertical columns under the summary:
 * left TD = New, next TD = Used. Return which side owns this month-header match.
 * @returns {"new"|"used"|null}
 */
function monthlySideForMatch(raw, matchIndex) {
  const html = String(raw || "");
  if (matchIndex == null || matchIndex < 0 || matchIndex >= html.length) return null;

  // Live BL monthly history: TR with four WIDTH="25%" columns (New | Used | …).
  // Only trust that layout — random valign=top TDs in fixtures must not force a side.
  const before = html.slice(Math.max(0, matchIndex - 12000), matchIndex);
  const colTds = [...before.matchAll(/<td\b[^>]*width\s*=\s*["']?25%["']?[^>]*>/gi)];
  if (colTds.length < 1) return null;

  const last = colTds[colTds.length - 1][0];
  const lastIdx = before.lastIndexOf(last);
  if (lastIdx < 0) return null;
  const absOpen = matchIndex - (before.length - lastIdx);
  const trStart = html.lastIndexOf("<tr", absOpen);
  if (trStart < 0) return null;
  const between = html.slice(trStart, absOpen + last.length);
  const colsInTr = [...between.matchAll(/<td\b[^>]*width\s*=\s*["']?25%["']?[^>]*>/gi)];
  const colIndex = Math.max(0, colsInTr.length - 1);
  if (colIndex === 0) return "new";
  if (colIndex === 1) return "used";
  return null;
}

function monthSectionIsEmpty(soldNew, soldUsed) {
  if (hasUsefulAgg(soldNew) || hasUsefulAgg(soldUsed)) return false;
  if (hasExplicitNoPriceCount(soldNew) || hasExplicitNoPriceCount(soldUsed)) return true;
  return (Number(soldNew?.count) || 0) === 0 && (Number(soldUsed?.count) || 0) === 0;
}

/**
 * Помесячные sold-блоки ниже сводки «Last 6 Months Sales».
 * Все месяцы на странице до текущего UTC включительно.
 */
/** Индекс первого заголовка «August 2026» в зоне помесячной детализации. */
function monthlyDetailStartIndex(raw) {
  const salesStart = raw.search(/Last\s*6\s*Months\s*Sales/i);
  const searchFrom = salesStart >= 0 ? salesStart : 0;
  const tail = raw.slice(searchFrom);
  const monthCut = tail.search(MONTH_HEADER_RE);
  if (monthCut < 0) return raw.length;
  const abs = searchFrom + monthCut;
  // На живых страницах BL заголовок месяца далеко ниже сводки; в коротких фикстурах — сразу после.
  if (monthCut > 1500) return abs;
  return abs;
}

function parseMonthlySoldChunk(chunkHtml, sideHint = null) {
  const chunk = String(chunkHtml || "");
  const { soldBlocks } = extractAggBlocks(chunk);
  const aggs = soldBlocks.map((b) => parseStatsBlock(b));
  const unavailableThenSold = /Unavailable[\s\S]{0,2500}?Times\s*Sold/i.test(chunk);

  // New cell empty marker before the only stats block → Used (never New).
  if (unavailableThenSold && aggs.length >= 1) {
    return { soldNew: emptyAgg(), soldUsed: aggs[0] || emptyAgg() };
  }

  // Known column (live BL): every Times Sold in this chunk belongs to that side.
  if (sideHint === "new" || sideHint === "used") {
    const first =
      aggs.find((a) => hasUsefulAgg(a) || hasExplicitNoPriceCount(a)) || emptyAgg();
    return sideHint === "new"
      ? { soldNew: first, soldUsed: emptyAgg() }
      : { soldNew: emptyAgg(), soldUsed: first };
  }

  if (aggs.length >= 2) {
    return {
      soldNew: aggs[0] || emptyAgg(),
      soldUsed: aggs[1] || emptyAgg(),
    };
  }

  const structured = parseStructuredSummary(chunk);
  if (structured && (hasUsefulAgg(structured.soldNew) || hasUsefulAgg(structured.soldUsed))) {
    return { soldNew: structured.soldNew, soldUsed: structured.soldUsed };
  }

  return {
    soldNew: aggs[0] || emptyAgg(),
    soldUsed: emptyAgg(),
  };
}

function parseMonthlySoldSections(html, opts = {}) {
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const currentPeriodId = utcYearMonth(new Date(nowMs));
  const raw = String(html || "");
  const detailStart = monthlyDetailStartIndex(raw);
  const matches = [...raw.matchAll(MONTH_HEADER_RE)];
  const byPeriod = new Map();

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    if (m.index < detailStart) continue;
    const periodId = monthLabelToPeriodId(m[1], m[2]);
    // Будущие месяцы не пишем; все прошлые и текущий — да (на BL бывают годы истории).
    if (!periodId || periodId > currentPeriodId) continue;

    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(raw.length, m.index + 12000);
    const chunk = raw.slice(m.index, end);
    const sideHint = monthlySideForMatch(raw, m.index);
    const sides = parseMonthlySoldChunk(chunk, sideHint);

    let row = byPeriod.get(periodId);
    if (!row) {
      row = { periodId, soldNew: emptyAgg(), soldUsed: emptyAgg() };
      byPeriod.set(periodId, row);
    }

    const pairInChunk =
      (hasUsefulAgg(sides.soldNew) || hasExplicitNoPriceCount(sides.soldNew)) &&
      (hasUsefulAgg(sides.soldUsed) || hasExplicitNoPriceCount(sides.soldUsed));
    if (pairInChunk && !sideHint) {
      row.soldNew = sides.soldNew;
      row.soldUsed = sides.soldUsed;
      continue;
    }

    if (hasUsefulAgg(sides.soldNew) || hasExplicitNoPriceCount(sides.soldNew)) {
      mergeMonthSide(row, sides.soldNew, sideHint || "new");
    } else if (hasUsefulAgg(sides.soldUsed) || hasExplicitNoPriceCount(sides.soldUsed)) {
      mergeMonthSide(row, sides.soldUsed, sideHint || "used");
    } else {
      const single = parseStatsFromMonthCell(chunk);
      if (hasUsefulAgg(single) || hasExplicitNoPriceCount(single)) {
        mergeMonthSide(row, single, sideHint);
      }
    }
  }

  // Пустые месяцы с заголовком на BL тоже оставляем (empty) —
  // запись no_data, чтобы не крутить их в очереди дыр вечно.
  return [...byPeriod.values()]
    .map((row) => ({
      periodId: row.periodId,
      soldNew: row.soldNew,
      soldUsed: row.soldUsed,
      empty: monthSectionIsEmpty(row.soldNew, row.soldUsed),
    }))
    .sort((a, b) => a.periodId.localeCompare(b.periodId));
}

function rowHasSoldSignal(row) {
  return hasUsefulAgg(row.soldNew) || hasUsefulAgg(row.soldUsed);
}

/**
 * Collect sold/stock HTML or plaintext clusters from summary.
 * Looser table regex + plaintext fallback when nested markup breaks tight windows.
 */
function extractAggBlocks(summary) {
  const soldBlocks = [];
  const stockBlocks = [];
  if (!summary) return { soldBlocks, stockBlocks };

  const soldRe =
    /Times\s*Sold:[\s\S]{0,800}?Total\s*Qty:[\s\S]{0,1500}?Max\s*Price:[\s\S]{0,400}?(?:<\/table>|(?=Times\s*Sold:)|(?=Total\s*Lots:)|$)/gi;
  const stockRe =
    /Total\s*Lots:[\s\S]{0,800}?Total\s*Qty:[\s\S]{0,1500}?Max\s*Price:[\s\S]{0,400}?(?:<\/table>|(?=Times\s*Sold:)|(?=Total\s*Lots:)|$)/gi;

  let m;
  while ((m = soldRe.exec(summary)) !== null) soldBlocks.push(m[0]);
  while ((m = stockRe.exec(summary)) !== null) stockBlocks.push(m[0]);

  if (soldBlocks.length >= 2 && stockBlocks.length >= 1) {
    return { soldBlocks, stockBlocks };
  }

  // Plaintext fallback / fill when nested markup breaks table windows.
  const plain = toPlainText(summary);
  const soldPlain = [];
  const stockPlain = [];
  const soldPlainRe =
    /Times\s*Sold\s*:\s*[\d,]+[\s\S]{0,500}?Max\s*Price\s*:\s*(?:US\s*)?\$?\s*[\d,.]+/gi;
  const stockPlainRe =
    /Total\s*Lots\s*:\s*[\d,]+[\s\S]{0,500}?Max\s*Price\s*:\s*(?:US\s*)?\$?\s*[\d,.]+/gi;

  while ((m = soldPlainRe.exec(plain)) !== null) soldPlain.push(m[0]);
  while ((m = stockPlainRe.exec(plain)) !== null) stockPlain.push(m[0]);

  return {
    soldBlocks: soldPlain.length > soldBlocks.length ? soldPlain : soldBlocks,
    stockBlocks: stockPlain.length > stockBlocks.length ? stockPlain : stockBlocks,
  };
}

function applyAggBlocks(result, soldBlocks, stockBlocks, contextHtml) {
  const mapped = mapSoldStockBlocksToSides(soldBlocks, stockBlocks, contextHtml);
  result.soldNew = mapped.soldNew;
  result.soldUsed = mapped.soldUsed;
  result.stockNew = mapped.stockNew;
  result.stockUsed = mapped.stockUsed;
}

/**
 * Main summary grid on catalogPG (ignore monthly detail tables below).
 */
function parseCatalogPgHtml(html) {
  const result = {
    ok: false,
    blocked: false,
    empty: false,
    method: "browser_catalogPG",
    currency: "USD",
    soldNew: emptyAgg(),
    soldUsed: emptyAgg(),
    stockNew: emptyAgg(),
    stockUsed: emptyAgg(),
  };

  const raw = String(html || "");
  const htmlBytes = raw.length;
  const title = extractHtmlTitle(raw);

  // Dead catalog entry (small PNF) → empty market. Large PNF → soft-block below.
  if (isDeadCatalogPage(raw, title)) {
    result.ok = true;
    result.empty = true;
    result.error = null;
    return result;
  }

  if (isWafChallengePage(raw)) {
    result.blocked = true;
    result.softBlocked = !/challenge-container|AwsWafIntegration/i.test(raw);
    if (!result.softBlocked) {
      result.error = "Still on AWS WAF challenge page";
    } else if (/Oops/i.test(title) || /Sorry!\s*\|\s*BrickLink/i.test(title)) {
      result.error = `Soft-blocked Oops shell (title=${title || "?"} bytes=${htmlBytes})`;
    } else if (hasPageNotFoundMarker(title, raw)) {
      result.error = `Soft-blocked Page Not Found shell (title=${title || "?"} bytes=${htmlBytes})`;
    } else {
      result.error = `Soft-blocked Price Guide shell (title=${title || "?"} bytes=${htmlBytes})`;
    }
    return result;
  }

  const summary = extractSummaryHtml(raw);
  if (summary) {
    const { soldBlocks, stockBlocks } = extractAggBlocks(summary);
    applyAggBlocks(result, soldBlocks, stockBlocks, summary);
  }

  // Structural (DOM-based) pass second: fixes cases where the legacy text-window regex
  // above cut a block short (nested tables) and dropped the price next to a real count.
  const structured = parseStructuredSummary(raw);
  if (structured) {
    result.soldNew = pickBetterAgg(structured.soldNew, result.soldNew);
    result.soldUsed = pickBetterAgg(structured.soldUsed, result.soldUsed);
    result.stockNew = pickBetterAgg(structured.stockNew, result.stockNew);
    result.stockUsed = pickBetterAgg(structured.stockUsed, result.stockUsed);
  }

  const hasPrices =
    hasUsefulAgg(result.soldNew) ||
    hasUsefulAgg(result.soldUsed) ||
    hasUsefulAgg(result.stockNew) ||
    hasUsefulAgg(result.stockUsed);

  if (hasPrices) {
    result.ok = true;
    result.empty = false;
    result.monthlySold = parseMonthlySoldSections(raw);
    // Сводка Last 6 Months есть — этого достаточно для точки. Нет помесячных
    // блоков на странице → пишем только сводку, не помечаем весь скрейп ошибкой.
    return result;
  }

  const partialCounts =
    hasCountsWithoutPrices(result.soldNew) ||
    hasCountsWithoutPrices(result.soldUsed) ||
    hasCountsWithoutPrices(result.stockNew) ||
    hasCountsWithoutPrices(result.stockUsed);

  if (partialCounts) {
    result.ok = false;
    result.empty = false;
    result.error = "Parsed lot/qty counts but no unit prices (currency format)";
    return result;
  }

  // Real market "N/A" price cells next to a lot count → legitimately no price, not a bug.
  const explicitNoPriceCount =
    hasExplicitNoPriceCount(result.soldNew) ||
    hasExplicitNoPriceCount(result.soldUsed) ||
    hasExplicitNoPriceCount(result.stockNew) ||
    hasExplicitNoPriceCount(result.stockUsed);

  if (explicitNoPriceCount) {
    result.ok = true;
    result.empty = true;
    result.error = null;
    result.monthlySold = parseMonthlySoldSections(raw);
    return result;
  }

  // Explicit empty-market copy on a real PG page → no_data
  if (looksEmptyPriceGuide(raw)) {
    result.ok = true;
    result.empty = true;
    result.error = null;
    result.monthlySold = [];
    return result;
  }

  // PG chrome / price markers present but blocks not mapped → error (retry), NOT empty
  if (hasUnmappedPriceMarkers(raw) || /Last\s*6\s*Months\s*Sales/i.test(raw)) {
    result.ok = false;
    result.empty = false;
    result.error = `Found PG chrome but failed to map sold/stock blocks (title=${title || "?"} bytes=${htmlBytes})`;
    return result;
  }

  result.error = `No price aggregates parsed from Price Guide HTML (title=${title || "?"} bytes=${htmlBytes})`;
  return result;
}

module.exports = {
  normalizeSetNo,
  parseMoney,
  parseIntSafe,
  emptyAgg,
  parseStatsBlock,
  hasUsefulAgg,
  hasCountsWithoutPrices,
  hasPriceGuideContent,
  hasPageNotFoundMarker,
  hasNoItemsFoundMarker,
  looksSoftBlockShell,
  errorLooksLikeSoftBlock,
  isDeadCatalogPage,
  isWafChallengePage,
  isPriceGuideShell,
  looksEmptyPriceGuide,
  extractSummaryHtml,
  extractAggBlocks,
  monthLabelToPeriodId,
  parseMonthlySoldSections,
  extractStructuredRows,
  groupRowsIntoBlocks,
  aggFromStructuredBlock,
  parseStructuredSummary,
  parseSummaryQuadColumns,
  mapSoldStockBlocksToSides,
  monthlySideForMatch,
  pickBetterAgg,
  isExplicitNoPricePlaceholder,
  hasExplicitNoPriceCount,
  parseCatalogPgHtml,
};
