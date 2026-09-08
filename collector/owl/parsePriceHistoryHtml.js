/**
 * Разбор вкладки Price History на карточке Brick Owl (#price / .ph-table).
 * Канон: BIF_parser.md — строка «6 Months» New/Used → sold (решение владельца).
 */
"use strict";

function parseMoney(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/[^\d.,\-]/g, "")
    .replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseIntLabel(raw) {
  if (raw == null) return 0;
  const s = String(raw).replace(/[^\d]/g, "");
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function emptyAgg() {
  return {
    count: 0,
    totalQty: 0,
    avgUsd: null,
    qtyAvgUsd: null,
    minUsd: null,
    maxUsd: null,
  };
}

function aggHasSignal(agg) {
  if (!agg) return false;
  if (Number(agg.count) > 0 || Number(agg.totalQty) > 0) return true;
  return agg.avgUsd != null || agg.minUsd != null || agg.maxUsd != null;
}

/**
 * Ячейка колонки: «Total Lots 59 … Average $1,055.29 …»
 * @param {string} cellText
 */
function parseWindowCell(cellText) {
  const t = String(cellText || "").replace(/\s+/g, " ").trim();
  if (!t || /^Total Amount\s*0$/i.test(t)) return emptyAgg();

  const lots = t.match(/Total Lots\s*([\d,]+)/i);
  const amount = t.match(/Total Amount\s*([\d,]+)/i);
  const avg = t.match(/Average\s*([$£€]?[\d,]+(?:\.\d+)?)/i);
  const max = t.match(/Maximum\s*([$£€]?[\d,]+(?:\.\d+)?)/i);
  const min = t.match(/Minimum\s*([$£€]?[\d,]+(?:\.\d+)?)/i);

  const count = lots ? parseIntLabel(lots[1]) : 0;
  const totalQty = amount ? parseIntLabel(amount[1]) : count;
  const avgUsd = avg ? parseMoney(avg[1]) : null;
  const maxUsd = max ? parseMoney(max[1]) : null;
  const minUsd = min ? parseMoney(min[1]) : null;

  if (totalQty <= 0 && count <= 0 && avgUsd == null) return emptyAgg();

  return {
    count: count || (avgUsd != null ? 1 : 0),
    totalQty: totalQty || count || (avgUsd != null ? 1 : 0),
    avgUsd,
    qtyAvgUsd: avgUsd,
    minUsd,
    maxUsd,
  };
}

const WINDOW_ALIASES = Object.freeze({
  current: "current",
  "6 months": "6m",
  "6 month": "6m",
  "1 year": "1y",
  "2 years": "2y",
  "2 year": "2y",
});

function normalizeWindowLabel(raw) {
  const s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return WINDOW_ALIASES[s] || null;
}

/**
 * @param {string} html
 */
function parseBrickOwlPriceHistoryHtml(html) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(String(html || ""));

  let boid = null;
  let setNumber = null;
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td, th")
      .map((__, el) => $(el).text().replace(/\s+/g, " ").trim())
      .get();
    if (cells.length >= 2 && /^BOID$/i.test(cells[0])) boid = cells[1] || null;
    if (cells.length >= 2 && /^Set Number$/i.test(cells[0])) setNumber = cells[1] || null;
  });

  const table =
    $("#price table.ph-table").first().length > 0
      ? $("#price table.ph-table").first()
      : $("table.ph-table").first();

  const windows = {};
  table.find("tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const header = $tr.find(".cellheader").first().text().replace(/\s+/g, " ").trim();
    const winKey = normalizeWindowLabel(header);
    if (!winKey) return;

    const tds = $tr.find("td").toArray();
    const allText = tds[1] ? $(tds[1]).text() : "";
    const newText = tds[2] ? $(tds[2]).text() : "";
    const usedText = tds[3] ? $(tds[3]).text() : "";
    windows[winKey] = {
      all: parseWindowCell(allText),
      soldNew: parseWindowCell(newText),
      soldUsed: parseWindowCell(usedText),
    };
  });

  const priceText = $("#price").text() || "";
  const lastUpdatedMatch = priceText.match(/Last Updated:\s*([^\n]+)/i);
  let currencyHint = null;
  if (/\$/.test(priceText)) currencyHint = "USD";
  else if (/£/.test(priceText)) currencyHint = "GBP";
  else if (/€/.test(priceText)) currencyHint = "EUR";

  return {
    boid: boid ? String(boid).trim() : null,
    setNumber: setNumber ? String(setNumber).trim() : null,
    currencyHint,
    windows,
    lastUpdated: lastUpdatedMatch ? lastUpdatedMatch[1].trim() : null,
  };
}

function sixMonthSoldFromParse(parsed) {
  const w = parsed && parsed.windows && parsed.windows["6m"];
  if (!w) return { soldNew: emptyAgg(), soldUsed: emptyAgg(), empty: true };
  const soldNew = w.soldNew || emptyAgg();
  const soldUsed = w.soldUsed || emptyAgg();
  const empty = !aggHasSignal(soldNew) && !aggHasSignal(soldUsed);
  return { soldNew, soldUsed, empty };
}

module.exports = {
  parseMoney,
  parseWindowCell,
  parseBrickOwlPriceHistoryHtml,
  sixMonthSoldFromParse,
  emptyAgg,
  aggHasSignal,
};
