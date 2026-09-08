/**
 * HTTP-съём Price History Brick Owl.
 *
 * Ходы:
 *  - если уже известен owlItemId (Drupal catalog.item_id) → **1** GET `/ajax/price/{id}`;
 *  - иначе один раз страница набора → вытащить item_id (+ boid) → ajax (**2** хода),
 *    item_id сохраняем в observation и дальше ходим напрямую.
 * BOID ≠ item_id: `/ajax/price/{boid}` пустой.
 */
"use strict";

const { brickOwlSearchSetUrl, brickOwlBoidUrl } = require("./boUrls");
const { parseBrickOwlPriceHistoryHtml, sixMonthSoldFromParse } = require("./parsePriceHistoryHtml");

const DEFAULT_UA =
  process.env.BO_USER_AGENT ||
  "BrickInFuture-parser/1.0 (+https://brickinfuture.com; price-history research)";

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url || url, text };
}

function extractSettingsJson(html) {
  const m = String(html || "").match(/id="settings_json">(\{[\s\S]*?\})<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractBoidFromPage(html) {
  const data = String(html || "").match(/data-boid=["'](\d+)["']/i);
  if (data) return data[1];
  const row = String(html || "").match(/>\s*BOID\s*<[\s\S]*?>\s*(\d+)\s*</i);
  if (row) return row[1];
  return null;
}

function extractSetNumberFromPage(html) {
  const row = String(html || "").match(/>\s*Set Number\s*<[\s\S]*?>\s*([0-9]+-[0-9]+)\s*</i);
  return row ? row[1] : null;
}

function htmlFromAjaxPriceCommands(raw) {
  let cmds;
  try {
    cmds = JSON.parse(String(raw || ""));
  } catch {
    return String(raw || "");
  }
  if (!Array.isArray(cmds)) return String(raw || "");
  let html = "";
  for (const c of cmds) {
    if (!c || typeof c !== "object") continue;
    if (c.command === "insert" && c.data) html += String(c.data);
    else if (c.html) html += String(c.html);
  }
  return html;
}

async function fetchAjaxPriceTable(owlItemId, referer) {
  const ajaxUrl = `https://www.brickowl.com/ajax/price/${encodeURIComponent(String(owlItemId))}`;
  const ajax = await fetchText(ajaxUrl, {
    headers: {
      Referer: referer || "https://www.brickowl.com/",
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
  });
  if (!ajax.ok) {
    return { ok: false, errorTag: `bo_ajax_http_${ajax.status}`, ajaxUrl, status: ajax.status };
  }
  const priceHtml = htmlFromAjaxPriceCommands(ajax.text);
  if (!/ph-table|cellheader/i.test(priceHtml)) {
    return { ok: false, errorTag: "bo_ajax_no_price_table", ajaxUrl, status: ajax.status };
  }
  return { ok: true, ajaxUrl, status: ajax.status, priceHtml };
}

/**
 * @param {{ setNo?: string, boid?: string, owlItemId?: string|number }} input
 */
async function fetchBrickOwlPriceHistory(input = {}) {
  const boidIn = input.boid ? String(input.boid).trim() : "";
  const setNo = input.setNo ? String(input.setNo).trim() : "";
  let owlItemId = input.owlItemId != null && String(input.owlItemId).trim()
    ? String(input.owlItemId).trim()
    : "";
  let pageUrl = null;
  let pageHtml = "";
  let hops = 0;

  if (!owlItemId) {
    if (!boidIn && !setNo) {
      return { ok: false, errorTag: "bo_no_id", method: "ajax_price_history_6m", hops: 0 };
    }
    pageUrl = boidIn ? brickOwlBoidUrl(boidIn) : brickOwlSearchSetUrl(setNo);
    const page = await fetchText(pageUrl);
    hops += 1;
    if (!page.ok) {
      return {
        ok: false,
        errorTag: `bo_http_${page.status}`,
        method: "ajax_price_history_6m",
        finalUrl: page.url,
        status: page.status,
        hops,
      };
    }
    pageUrl = page.url;
    pageHtml = page.text;
    const settings = extractSettingsJson(pageHtml);
    owlItemId = settings?.catalog?.item_id ? String(settings.catalog.item_id) : "";
    if (!owlItemId) {
      return {
        ok: false,
        errorTag: "bo_no_catalog_item_id",
        method: "ajax_price_history_6m",
        finalUrl: pageUrl,
        hops,
      };
    }
  }

  const ajax = await fetchAjaxPriceTable(owlItemId, pageUrl || brickOwlBoidUrl(boidIn) || undefined);
  hops += 1;
  if (!ajax.ok) {
    return {
      ok: false,
      errorTag: ajax.errorTag,
      method: owlItemId && !pageHtml ? "ajax_price_direct_6m" : "ajax_price_history_6m",
      finalUrl: pageUrl,
      ajaxUrl: ajax.ajaxUrl,
      status: ajax.status,
      catalogItemIdOwl: owlItemId,
      hops,
    };
  }

  const wrapped = `<div id="price">${ajax.priceHtml}</div>${pageHtml}`;
  const parsed = parseBrickOwlPriceHistoryHtml(wrapped);
  if (!parsed.boid) parsed.boid = extractBoidFromPage(pageHtml) || boidIn || null;
  if (!parsed.setNumber) parsed.setNumber = extractSetNumberFromPage(pageHtml) || setNo || null;

  const six = sixMonthSoldFromParse(parsed);
  const direct = !pageHtml;
  return {
    ok: true,
    method: direct ? "ajax_price_direct_6m" : "ajax_price_history_6m",
    finalUrl: pageUrl || ajax.ajaxUrl,
    ajaxUrl: ajax.ajaxUrl,
    status: ajax.status,
    catalogItemIdOwl: owlItemId,
    hops,
    parsed,
    soldNew: six.soldNew,
    soldUsed: six.soldUsed,
    empty: six.empty,
  };
}

module.exports = {
  fetchBrickOwlPriceHistory,
  fetchText,
  extractSettingsJson,
  htmlFromAjaxPriceCommands,
};
