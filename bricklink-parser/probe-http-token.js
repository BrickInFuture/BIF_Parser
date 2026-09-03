/**
 * PROBE (hypothesis A): warm one Chromium session to clear the AWS WAF
 * challenge, grab the resulting cookies, then fetch many Price Guide pages
 * with plain HTTP (global fetch / undici) reusing that token.
 *
 * Goal: measure whether HTTP-with-token is dramatically faster than a full
 * browser navigation per set, and how many pages the token survives before
 * BrickLink soft-blocks the GitHub/plain-HTTP request again.
 *
 * This is a READ-ONLY experiment: it never writes to Firestore.
 *
 *   node scripts/bricklink-parser/probe-http-token.js
 *   node scripts/bricklink-parser/probe-http-token.js --headed
 *   node scripts/bricklink-parser/probe-http-token.js --sets=75192-1,10276-1 --browserBaseline=3
 *
 * Flags:
 *   --headed              run Chromium headed (often clears WAF more reliably)
 *   --sets=a,b,c          override the built-in test set list
 *   --browserBaseline=N   also time N browser fetches for comparison (default 3)
 *   --pause=800,1500      polite pause range between HTTP fetches (ms)
 *   --save-html           dump each HTTP body to out/probe-*.html
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { BrickLinkSession } = require("./session");
const {
  parseCatalogPgHtml,
  isWafChallengePage,
  looksSoftBlockShell,
  hasPriceGuideContent,
  hasNoItemsFoundMarker,
} = require("./parseHtml");
const { brickLinkCatalogPgUrl } = require("./blUrls");

const OUT_DIR = path.join(__dirname, "out");
const HEADLESS = !process.argv.includes("--headed");
const SAVE_HTML = process.argv.includes("--save-html");

// Spread of real, popular sets likely to have a live Price Guide.
const DEFAULT_SETS = [
  "75192-1",
  "10276-1",
  "21318-1",
  "42115-1",
  "10281-1",
  "31058-1",
  "75257-1",
  "60380-1",
  "71043-1",
  "10497-1",
  "42151-1",
  "76989-1",
];

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function parsePauseRange() {
  const raw = String(argValue("pause", "800,1500"));
  const parts = raw.split(/[,:\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (parts.length >= 2) return [parts[0], parts[1]];
  if (parts.length === 1) return [parts[0], parts[0]];
  return [800, 1500];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInRange([min, max]) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Classify a raw HTML body into ok / empty / soft_block / waf / unknown. */
function classifyHtml(html, httpStatus) {
  const raw = String(html || "");
  if (httpStatus && httpStatus >= 400) {
    // 403/405/5xx from WAF or edge — treat as block signal.
    return { kind: "http_error", detail: `status_${httpStatus}` };
  }
  const parsed = parseCatalogPgHtml(raw);
  if (parsed.blocked) {
    return { kind: parsed.softBlocked ? "soft_block" : "waf", parsed };
  }
  if (parsed.ok && parsed.empty) return { kind: "empty", parsed };
  if (parsed.ok) return { kind: "ok", parsed };
  // Fallbacks if parse returned not-ok without a blocked flag.
  if (isWafChallengePage(raw)) return { kind: "waf", parsed };
  if (looksSoftBlockShell(null, raw)) return { kind: "soft_block", parsed };
  if (hasNoItemsFoundMarker(raw)) return { kind: "empty", parsed };
  return { kind: "unknown", parsed };
}

function cookieHeaderFromPlaywright(cookies) {
  return cookies
    .filter((c) => /bricklink\.com$/i.test(String(c.domain || "").replace(/^\./, "")) || /bricklink/i.test(String(c.domain || "")))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

async function httpFetch(url, { cookie, userAgent }) {
  const started = Date.now();
  let status = 0;
  let bytes = 0;
  let html = "";
  let err = null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Referer: "https://www.bricklink.com/",
        Cookie: cookie,
      },
    });
    status = res.status;
    html = await res.text();
    bytes = html.length;
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  return { ms: Date.now() - started, status, bytes, html, err };
}

function summarize(label, rows) {
  const okMs = rows.filter((r) => r.ms != null).map((r) => r.ms);
  const avg = okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null;
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return { label, n: rows.length, avgMs: avg, counts };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const sets = String(argValue("sets", DEFAULT_SETS.join(",")))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const browserBaseline = Math.max(0, Number(argValue("browserBaseline", "3")) || 0);
  const pauseRange = parsePauseRange();

  console.log(
    JSON.stringify(
      { step: "probe_start", sets: sets.length, headless: HEADLESS, browserBaseline, pauseRange },
      null,
      2
    )
  );

  const session = new BrickLinkSession({ headless: HEADLESS });
  const browserRows = [];
  const httpRows = [];

  try {
    const warmStarted = Date.now();
    await session.warmUp();
    const warmMs = Date.now() - warmStarted;
    console.log(JSON.stringify({ step: "warmed_up", warmMs }));

    // --- Baseline: a few full browser scrapes (existing path) ---
    for (let i = 0; i < Math.min(browserBaseline, sets.length); i++) {
      const setNo = sets[i];
      const t0 = Date.now();
      let kind = "unknown";
      try {
        const r = await session.fetchSet(setNo, { catalogPass: true });
        const p = r.parsed || {};
        kind = p.blocked ? (p.softBlocked ? "soft_block" : "waf") : p.ok ? (p.empty ? "empty" : "ok") : "unknown";
      } catch (e) {
        kind = "error";
      }
      const ms = Date.now() - t0;
      browserRows.push({ setNo, ms, kind });
      console.log(JSON.stringify({ step: "browser_fetch", setNo, ms, kind }));
    }

    // --- Grab WAF cookies from the warmed context ---
    const cookies = await session.context.cookies();
    const cookie = cookieHeaderFromPlaywright(cookies);
    const userAgent = await session.page.evaluate(() => navigator.userAgent).catch(
      () =>
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    const cookieNames = cookies.map((c) => c.name);
    console.log(
      JSON.stringify({
        step: "token_captured",
        cookieCount: cookies.length,
        cookieNames,
        hasAwsWaf: cookieNames.some((n) => /waf/i.test(n)),
        cookieHeaderBytes: cookie.length,
      })
    );

    // Close the browser now — we want a pure HTTP test, no browser overhead.
    await session.close();

    // --- HTTP-with-token loop ---
    let firstBlockAt = null;
    for (let i = 0; i < sets.length; i++) {
      const setNo = sets[i];
      const url = brickLinkCatalogPgUrl("SET", setNo);
      const res = await httpFetch(url, { cookie, userAgent });
      const cls = res.err ? { kind: "fetch_error" } : classifyHtml(res.html, res.status);
      const row = { setNo, ms: res.ms, status: res.status, bytes: res.bytes, kind: cls.kind, err: res.err };
      httpRows.push(row);
      if (firstBlockAt == null && (cls.kind === "soft_block" || cls.kind === "waf" || cls.kind === "http_error")) {
        firstBlockAt = i + 1;
      }
      console.log(
        JSON.stringify({ step: "http_fetch", i: i + 1, setNo, ms: res.ms, status: res.status, bytes: res.bytes, kind: cls.kind, err: res.err || undefined })
      );
      if (SAVE_HTML && res.html) {
        const p = path.join(OUT_DIR, `probe-${setNo.replace(/[^\w.-]/g, "_")}.html`);
        fs.writeFileSync(p, res.html, "utf8");
      }
      if (i < sets.length - 1) await sleep(randomInRange(pauseRange));
    }

    // --- Report ---
    const httpSummary = summarize("http_token", httpRows);
    const browserSummary = summarize("browser", browserRows);
    const okHttp = httpRows.filter((r) => r.kind === "ok" || r.kind === "empty").length;
    const speedup =
      browserSummary.avgMs && httpSummary.avgMs
        ? Number((browserSummary.avgMs / httpSummary.avgMs).toFixed(1))
        : null;

    console.log("\n=== PROBE RESULT (hypothesis A) ===");
    console.log(JSON.stringify({ browser: browserSummary, http: httpSummary }, null, 2));
    const report = {
      ranAt: new Date().toISOString(),
      env: {
        headless: HEADLESS,
        pauseRange,
        sets: sets.length,
        browserBaseline,
        node: process.version,
        ci: process.env.GITHUB_ACTIONS === "true",
        runner: process.env.RUNNER_OS || null,
      },
      browser: browserSummary,
      http: httpSummary,
      browserRows,
      httpRows,
      verdict: {
        httpUsableRate: `${okHttp}/${httpRows.length}`,
        firstBlockAtRequest: firstBlockAt,
        avgBrowserMs: browserSummary.avgMs,
        avgHttpMs: httpSummary.avgMs,
        httpSpeedupVsBrowser: speedup,
      },
    };
    console.log(JSON.stringify({ verdict: report.verdict }, null, 2));
    const reportPath = path.join(OUT_DIR, "probe-http-token-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify({ step: "report_saved", reportPath }));
  } finally {
    try {
      await session.close();
    } catch {
      // already closed
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("PROBE ERROR:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { classifyHtml, cookieHeaderFromPlaywright };
