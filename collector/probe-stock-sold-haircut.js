/**
 * One-shot probe: market Store API stock vs sold → haircut = sold/stock.
 * Creds from Server/Config.js (Apps Script style). Does not print secrets.
 *
 *   node collector/probe-stock-sold-haircut.js
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const CONFIG_PATH = path.join(ROOT, "Server", "Config.js");

/** Diverse sample: theme / age / liquidity / price band */
const SAMPLE = [
  { no: "75192-1", type: "SET", theme: "Star Wars", band: "ucs_high", age: "mature" },
  { no: "75257-1", type: "SET", theme: "Star Wars", band: "mid", age: "mature" },
  { no: "75313-1", type: "SET", theme: "Star Wars", band: "ucs_high", age: "recent" },
  { no: "10294-1", type: "SET", theme: "Creator Expert", band: "high", age: "mature" },
  { no: "10305-1", type: "SET", theme: "Icons", band: "high", age: "recent" },
  { no: "21318-1", type: "SET", theme: "Ideas", band: "mid", age: "mature" },
  { no: "21345-1", type: "SET", theme: "Ideas", band: "mid", age: "recent" },
  { no: "42151-1", type: "SET", theme: "Technic", band: "high", age: "recent" },
  { no: "42115-1", type: "SET", theme: "Technic", band: "mid", age: "mature" },
  { no: "60380-1", type: "SET", theme: "City", band: "mid", age: "recent" },
  { no: "60271-1", type: "SET", theme: "City", band: "low", age: "mature" },
  { no: "71043-1", type: "SET", theme: "Harry Potter", band: "ucs_high", age: "mature" },
  { no: "76419-1", type: "SET", theme: "Harry Potter", band: "mid", age: "recent" },
  { no: "76989-1", type: "SET", theme: "Speed Champions", band: "low", age: "recent" },
  { no: "10497-1", type: "SET", theme: "Galaxy Explorer", band: "mid", age: "recent" },
  { no: "10276-1", type: "SET", theme: "Creator Expert", band: "high", age: "mature" },
  { no: "21058-1", type: "SET", theme: "Architecture", band: "mid", age: "recent" },
  { no: "31120-1", type: "SET", theme: "Creator 3-in-1", band: "low", age: "mature" },
  { no: "71741-1", type: "SET", theme: "Ninjago", band: "mid", age: "mature" },
  { no: "76251-1", type: "SET", theme: "Marvel", band: "mid", age: "recent" },
  { no: "43217-1", type: "SET", theme: "Disney", band: "mid", age: "recent" },
  { no: "40579-1", type: "SET", theme: "GWP / promo", band: "low", age: "recent" },
  { no: "sw0525", type: "MINIFIG", theme: "Minifig SW", band: "fig", age: "mature" },
  { no: "col461", type: "MINIFIG", theme: "Minifig CMF", band: "fig", age: "recent" },
];

function loadBlCreds() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const pick = (key) => {
    const m = raw.match(new RegExp(`${key}\\s*:\\s*['\"]([^'\"]+)['\"]`));
    if (!m) throw new Error(`Missing ${key} in Config.js`);
    return m[1];
  };
  return {
    consumerKey: pick("consumerKey"),
    consumerSecret: pick("consumerSecret"),
    tokenValue: pick("tokenValue"),
    tokenSecret: pick("tokenSecret"),
  };
}

function pctEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function oauthHeader(method, url, query, creds) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.tokenValue,
    oauth_version: "1.0",
  };
  const all = { ...query, ...oauth };
  const paramStr = Object.keys(all)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), pctEncode(url), pctEncode(paramStr)].join("&");
  const key = `${pctEncode(creds.consumerSecret)}&${pctEncode(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  const parts = Object.keys(oauth)
    .sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`);
  return `OAuth ${parts.join(", ")}`;
}

async function blGet(path, query, creds) {
  const base = `https://api.bricklink.com/api/store/v1${path}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(query[k])}`)
    .join("&");
  const url = qs ? `${base}?${qs}` : base;
  const res = await fetch(url, {
    headers: {
      Authorization: oauthHeader("GET", base, query, creds),
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON: ${text.slice(0, 120)}`);
  }
  if (!res.ok || !(json.meta && json.meta.code >= 200 && json.meta.code < 300)) {
    throw new Error(`API ${path} → ${res.status} ${JSON.stringify(json.meta || {}).slice(0, 160)}`);
  }
  return json.data || {};
}

function priceOf(d) {
  if (!d) return null;
  const v = d.qty_avg_price != null ? d.qty_avg_price : d.avg_price;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function qtyOf(d) {
  if (!d) return 0;
  const u = Number(d.unit_quantity);
  const t = Number(d.total_quantity);
  if (Number.isFinite(u) && u > 0) return u;
  if (Number.isFinite(t) && t > 0) return t;
  return 0;
}

async function fetchSide(creds, type, no, cond) {
  const path = `/items/${type.toLowerCase()}/${encodeURIComponent(no)}/price`;
  const [stock, sold] = await Promise.all([
    blGet(path, { guide_type: "stock", new_or_used: cond, currency_code: "USD" }, creds),
    blGet(path, { guide_type: "sold", new_or_used: cond, currency_code: "USD" }, creds),
  ]);
  return {
    stock: priceOf(stock),
    sold: priceOf(sold),
    stockQty: qtyOf(stock),
    soldQty: qtyOf(sold),
  };
}

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function summarize(label, rows) {
  const hs = rows.map((r) => r.haircut).filter((x) => x != null);
  if (!hs.length) {
    console.log(`  ${label}: n=0`);
    return;
  }
  const avg = hs.reduce((s, x) => s + x, 0) / hs.length;
  console.log(
    `  ${label}: n=${hs.length} median=${median(hs).toFixed(3)} mean=${avg.toFixed(3)} ` +
      `min=${Math.min(...hs).toFixed(3)} max=${Math.max(...hs).toFixed(3)}`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const creds = loadBlCreds();
  const rows = [];
  console.log(`Probe stock/sold haircut · ${SAMPLE.length} items · USD qty_avg\n`);

  for (const item of SAMPLE) {
    for (const cond of ["N", "U"]) {
      try {
        const side = await fetchSide(creds, item.type, item.no, cond);
        const haircut =
          side.stock != null && side.sold != null && side.stock > 0
            ? side.sold / side.stock
            : null;
        const row = {
          ...item,
          cond: cond === "N" ? "new" : "used",
          ...side,
          haircut,
        };
        rows.push(row);
        const h = haircut == null ? "—" : haircut.toFixed(3);
        console.log(
          `${item.no.padEnd(10)} ${row.cond.padEnd(4)} ${item.theme.padEnd(18)} ` +
            `stock=${side.stock ?? "—"} (${side.stockQty}) sold=${side.sold ?? "—"} (${side.soldQty}) ` +
            `h=${h}`
        );
      } catch (e) {
        console.log(`${item.no.padEnd(10)} ${cond} ERROR ${String(e.message || e).slice(0, 120)}`);
      }
      await sleep(350);
    }
  }

  const ok = rows.filter((r) => r.haircut != null && r.haircut > 0 && r.haircut < 3);
  console.log("\n=== Summary (0 < haircut < 3) ===");
  summarize("ALL", ok);
  summarize("new", ok.filter((r) => r.cond === "new"));
  summarize("used", ok.filter((r) => r.cond === "used"));
  for (const band of ["ucs_high", "high", "mid", "low", "fig"]) {
    summarize(`band:${band}`, ok.filter((r) => r.band === band));
  }
  for (const age of ["recent", "mature"]) {
    summarize(`age:${age}`, ok.filter((r) => r.age === age));
  }
  summarize(
    "liq:soldQty>=10",
    ok.filter((r) => r.soldQty >= 10)
  );
  summarize(
    "liq:soldQty<5",
    ok.filter((r) => r.soldQty > 0 && r.soldQty < 5)
  );
  summarize(
    "stockLots>=20",
    ok.filter((r) => r.stockQty >= 20)
  );
  summarize(
    "stockLots<5",
    ok.filter((r) => r.stockQty > 0 && r.stockQty < 5)
  );

  const outPath = path.join(__dirname, "out", "stock-sold-haircut-probe.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
