/**
 * Persistent collector session: one Chromium warm-up for AWS WAF token,
 * then many Price Guide fetches via plain HTTP reusing cookies (hypothesis A).
 * Falls back to full browser navigation when HTTP fails or BL_HTTP_FETCH=0.
 *
 * Phase-1 throughput: adaptive pause, cheap soft-block retry (no hard-restart
 * loops), per-fetch timing logs, optional BL_PROXY_URL.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  parseCatalogPgHtml,
  normalizeSetNo,
  isWafChallengePage,
  hasPriceGuideContent,
  looksEmptyPriceGuide,
  hasPageNotFoundMarker,
  hasNoItemsFoundMarker,
  looksSoftBlockShell,
} = require("./parseHtml");
const { marketCatalogPgUrl, normalizeItemNumber } = require("./blUrls");

const DEFAULT_TIMEOUT_MS = Number(process.env.BL_PARSE_TIMEOUT_MS || 90000) || 90000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HTTP_METHOD = "http_token_catalogPG";
const BROWSER_METHOD = "playwright_session_catalogPG";
const BROWSER_FALLBACK_METHOD = "playwright_fallback_catalogPG";

/** Adaptive floor after a success streak (ms). Overridden if BL_PAUSE_MS is tighter. */
const ADAPTIVE_PAUSE_FLOOR = [800, 1200];
/** Short cool before one soft-block retry (ms). */
const SOFT_BLOCK_COOL_MS = [5000, 10000];
/** Successes before shrinking pause toward the adaptive floor. */
const ADAPTIVE_SHRINK_AFTER = 3;
/** Fail-fast soft-block detect window (ms). Logs showed ~24s wait was killing throughput. */
const SOFT_BLOCK_FAST_MS = Math.max(
  800,
  Number(process.env.BL_SOFT_BLOCK_FAST_MS || 3000) || 3000
);
/** Consecutive soft_blocks before opening circuit cool. */
const CIRCUIT_SOFT_LIMIT = Math.max(
  2,
  Number(process.env.BL_CIRCUIT_SOFT_LIMIT || 5) || 5
);

function circuitCoolRange() {
  return [
    Number(process.env.BL_CIRCUIT_COOL_MIN_MS || 180000) || 180000,
    Number(process.env.BL_CIRCUIT_COOL_MAX_MS || 480000) || 480000,
  ];
}

/** When true, circuit cools then continues; when false, stopRequested kills the window. */
function circuitCoolAndContinue() {
  if (process.env.BL_CIRCUIT_STOP === "1") return false;
  return process.env.BL_CIRCUIT_COOL !== "0";
}

function adaptivePauseEnabled(proxyUrl) {
  if (process.env.BL_ADAPTIVE_PAUSE === "0") return false;
  // On GitHub Actions without proxy, shrinking pause accelerates into WAF.
  if (process.env.GITHUB_ACTIONS === "true" && !parseProxyUrl(proxyUrl || process.env.BL_PROXY_URL)) {
    return false;
  }
  return true;
}

/** Default true — set BL_HTTP_FETCH=0 to force legacy browser-per-set. */
function httpFetchEnabled() {
  return process.env.BL_HTTP_FETCH !== "0";
}

function rateLimitBackoffRange() {
  return [
    Math.max(5000, Number(process.env.BL_HTTP_429_MIN_MS || 30000) || 30000),
    Math.max(10000, Number(process.env.BL_HTTP_429_MAX_MS || 60000) || 60000),
  ];
}

function extractHtmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : "";
}

function cookieHeaderFromPlaywright(cookies) {
  return cookies
    .filter(
      (c) =>
        /bricklink\.com$/i.test(String(c.domain || "").replace(/^\./, "")) ||
        /bricklink/i.test(String(c.domain || ""))
    )
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
const HTML_DUMP_DIR = path.join(__dirname, "_html_dumps");
/** Keep the diagnostics folder from growing unbounded on long-running nightly jobs. */
const HTML_DUMP_MAX_FILES = 300;

/**
 * Classify a failed/blocked scrape into a short tag for logs, stats and dump filenames.
 * Distinguishes "site blocked us" / "page never loaded" from "page loaded fine but our
 * price-reading rule failed" — these need very different fixes.
 */
function classifyErrorTag(parsed, waitError) {
  if (parsed?.blocked) return parsed.softBlocked ? "soft_blocked" : "waf_blocked";
  // waitError comes from the live poll (richer Oops detection); prefer it over static re-parse.
  const err = String(waitError || parsed?.error || "");
  if (/Soft-blocked/i.test(err)) return "soft_blocked";
  if (/Oops/i.test(err) || /Sorry!\s*\|\s*BrickLink/i.test(err)) return "soft_blocked";
  if (/currency format/i.test(err)) return "partial_prices";
  if (/failed to map|Found PG chrome/i.test(err)) return "unmapped_blocks";
  if (/Timeout waiting/i.test(err)) return "timeout";
  if (/No price aggregates/i.test(err)) return "no_aggregates";
  if (!parsed?.ok) return "parse_error";
  return "unknown";
}

/** Best-effort save of the raw HTML behind a failed scrape, for offline debugging/fixtures. */
function dumpFailureHtml(setNo, html, tag) {
  try {
    if (!html) return null;
    if (!fs.existsSync(HTML_DUMP_DIR)) fs.mkdirSync(HTML_DUMP_DIR, { recursive: true });

    const existing = fs.readdirSync(HTML_DUMP_DIR).filter((f) => f.endsWith(".html"));
    if (existing.length >= HTML_DUMP_MAX_FILES) {
      const oldest = existing
        .map((f) => ({ f, mtime: fs.statSync(path.join(HTML_DUMP_DIR, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime)
        .slice(0, existing.length - HTML_DUMP_MAX_FILES + 1);
      for (const { f } of oldest) fs.unlinkSync(path.join(HTML_DUMP_DIR, f));
    }

    const safeSet = String(setNo || "unknown").replace(/[^\w.-]/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(HTML_DUMP_DIR, `${safeSet}-${tag}-${ts}.html`);
    fs.writeFileSync(file, html, "utf8");
    return file;
  } catch (e) {
    console.error("dumpFailureHtml failed:", e && e.message ? e.message : e);
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInRange(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Parse BL_PAUSE_MS="1500,3000" or fall back. */
function defaultPauseMs() {
  const raw = String(process.env.BL_PAUSE_MS || "").trim();
  if (raw) {
    const parts = raw.split(/[,:\s]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 0);
    if (parts.length >= 2) return [parts[0], parts[1]];
    if (parts.length === 1) return [parts[0], parts[0]];
  }
  return [1500, 3000];
}

/**
 * Playwright proxy from BL_PROXY_URL / opts.proxyUrl.
 * Supports http(s)://user:pass@host:port and host:port.
 * @returns {{ server: string, username?: string, password?: string } | null}
 */
function parseProxyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    const port = u.port ? `:${u.port}` : "";
    const out = { server: `${u.protocol}//${u.hostname}${port}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return null;
  }
}

function isSoftBlockedResult(result) {
  if (result?.parsed?.blocked && result.parsed.softBlocked) return true;
  const err = String(result?.waitError || result?.parsed?.error || "");
  if (/Soft-blocked/i.test(err)) return true;
  // Historical / mis-tagged Oops pages that still say "No price aggregates (title=Oops…)"
  if (/Oops/i.test(err) || /Sorry!\s*\|\s*BrickLink/i.test(err)) return true;
  return false;
}

function isHardWafResult(result) {
  if (isSoftBlockedResult(result)) return false;
  if (result?.parsed?.blocked && !result.parsed.softBlocked) return true;
  if (result?.challengeCleared === false) return true;
  const err = String(result?.waitError || result?.parsed?.error || "");
  return /AwsWafIntegration|Still on AWS WAF|challenge/i.test(err);
}

function pageLooksReady(html, title) {
  const raw = String(html || "");
  // Catalog miss (any size) → empty market, not soft-block.
  if (hasNoItemsFoundMarker(raw) && !hasPriceGuideContent(raw)) return "empty";
  // Large Page Not Found without PG chrome → not ready (junk / soft-block)
  if (hasPageNotFoundMarker(title, raw)) {
    if (!hasPriceGuideContent(raw) && raw.length >= 12000) return null;
    if (!hasPriceGuideContent(raw)) return "empty"; // small dead catalog page
  }
  if (/Avg\s*Price|Qty\s*Avg\s*Price|Times\s*Sold|Total\s*Lots/i.test(raw)) return "prices";
  if (looksEmptyPriceGuide(raw)) return "empty";
  // Real PG chrome in body — not title alone
  if (/Last\s*6\s*Months\s*Sales|Current\s*Items\s*for\s*Sale/i.test(raw)) return "shell";
  return null;
}

async function waitForPriceGuide(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // Prefer explicit fast window (default 3s); never wait the old ~12s soft gate.
  const softBlockAfterMs = Math.min(SOFT_BLOCK_FAST_MS, Math.floor(timeoutMs * 0.15));
  const started = Date.now();

  while (Date.now() < deadline) {
    const html = await page.content();
    const title = await page.title().catch(() => "");

    const interstitial =
      (/id=["']challenge-container["']/i.test(html) ||
        /AwsWafIntegration\.(getToken|forceRefreshToken)/i.test(html)) &&
      html.length < 8000;

    // Stuck tiny WAF interstitial past fail-fast window → soft_block (was burning full timeout ~90s).
    if (interstitial && Date.now() - started >= softBlockAfterMs) {
      return {
        ok: false,
        html,
        title,
        url: page.url(),
        error: "Soft-blocked or incomplete Price Guide page",
        waitMs: Date.now() - started,
      };
    }

    if (!interstitial) {
      // Immediate soft-block shell (Oops / Error / large PNF) — do not poll for 12–24s.
      if (looksSoftBlockShell(title, html) || isWafChallengePage(html)) {
        // Tiny challenge interstitial already handled above; large junk = soft_block.
        if (!(html.length < 8000 && /AwsWafIntegration/i.test(html))) {
          return {
            ok: false,
            html,
            title,
            url: page.url(),
            error: "Soft-blocked or incomplete Price Guide page",
            waitMs: Date.now() - started,
          };
        }
      }

      const kind = pageLooksReady(html, title);
      if (kind === "prices") {
        return { ok: true, html, title, url: page.url(), waitMs: Date.now() - started };
      }
      if (kind === "empty" || kind === "shell") {
        return {
          ok: true,
          html,
          title,
          url: page.url(),
          emptyShell: kind !== "prices",
          waitMs: Date.now() - started,
        };
      }

      // Incomplete page past fast window with no PG chrome → soft fail.
      if (Date.now() - started >= softBlockAfterMs) {
        const junk =
          isWafChallengePage(html) ||
          looksSoftBlockShell(title, html) ||
          hasPageNotFoundMarker(title, html) ||
          (html.length > 3000 && !pageLooksReady(html, title));
        if (junk) {
          return {
            ok: false,
            html,
            title,
            url: page.url(),
            error: "Soft-blocked or incomplete Price Guide page",
            waitMs: Date.now() - started,
          };
        }
      }
    }

    await sleep(400);
  }
  return {
    ok: false,
    html: await page.content(),
    title: await page.title().catch(() => ""),
    url: page.url(),
    error: "Timeout waiting for Price Guide after WAF challenge",
    waitMs: Date.now() - started,
  };
}

class CollectorSession {
  /**
   * @param {{ headless?: boolean, timeoutMs?: number, pauseMs?: [number, number], proxyUrl?: string }} opts
   */
  constructor(opts = {}) {
    this.headless = opts.headless !== false;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const pause = opts.pauseMs || defaultPauseMs();
    this.basePauseMin = pause[0];
    this.basePauseMax = pause[1];
    this.pauseMin = pause[0];
    this.pauseMax = pause[1];
    this.proxyUrl = opts.proxyUrl != null ? opts.proxyUrl : process.env.BL_PROXY_URL || "";
    this.browser = null;
    this.context = null;
    this.page = null;
    this.warmed = false;
    this.consecutiveFails = 0;
    this.successStreak = 0;
    this.consecutiveSoftBlocks = 0;
    this.circuitOpen = false;
    this.circuitTrips = 0;
    /** When true, ingest loops should stop the time window instead of waiting out circuit cool. */
    this.stopRequested = false;
    /** Cached aws-waf-token cookie jar for plain HTTP fetches. */
    this.httpCookieHeader = null;
    this.httpUserAgent = DEFAULT_USER_AGENT;
  }

  isCircuitOpen() {
    return !!this.circuitOpen || !!this.stopRequested;
  }

  /** After jumping a same-base variant cluster so consecutive shells do not trip the mixed-IP circuit. */
  clearSoftBlockStreak() {
    this.consecutiveSoftBlocks = 0;
  }

  async open() {
    if (this.page) return;
    const launchOpts = {
      headless: this.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
      ],
    };
    const proxy = parseProxyUrl(this.proxyUrl);
    if (proxy) {
      launchOpts.proxy = proxy;
      console.log(
        JSON.stringify({
          step: "proxy_enabled",
          server: proxy.server,
          hasAuth: Boolean(proxy.username),
        })
      );
    }

    this.browser = await chromium.launch(launchOpts);
    this.context = await this.browser.newContext({
      userAgent: DEFAULT_USER_AGENT,
      locale: "en-US",
      viewport: { width: 1365, height: 900 },
      timezoneId: "UTC",
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get() { return undefined; } });
    });
    this.page = await this.context.newPage();
  }

  async warmUp() {
    await this.open();
    if (this.warmed) return;
    await this.page.goto("https://www.bricklink.com/", {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    await sleep(1000 + Math.floor(Math.random() * 700));
    this.warmed = true;
    await this.#syncHttpAuth();
  }

  async #syncHttpAuth() {
    if (!this.context) return;
    const cookies = await this.context.cookies();
    this.httpCookieHeader = cookieHeaderFromPlaywright(cookies);
    this.httpUserAgent =
      (await this.page.evaluate(() => navigator.userAgent).catch(() => null)) || DEFAULT_USER_AGENT;
  }

  async #refreshHttpToken() {
    this.warmed = false;
    this.httpCookieHeader = null;
    await this.warmUp();
  }

  async #rateLimitBackoff() {
    const ms = randomInRange(...rateLimitBackoffRange());
    console.log(JSON.stringify({ step: "http_429_backoff_ms", ms }));
    await sleep(ms);
    return ms;
  }

  async #httpGet(url) {
    const started = Date.now();
    let status = 0;
    let html = "";
    let err = null;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": this.httpUserAgent || DEFAULT_USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Referer: "https://www.market.com/",
          Cookie: this.httpCookieHeader || "",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      html = await res.text();
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }
    return { ms: Date.now() - started, status, html, err };
  }

  #packHttpWaited(res, html) {
    const title = extractHtmlTitle(html);
    const parsed = parseCatalogPgHtml(html);
    const blocked = !!parsed.blocked;
    const ok =
      !blocked &&
      (parsed.ok ||
        (hasNoItemsFoundMarker(html) && !hasPriceGuideContent(html)) ||
        looksEmptyPriceGuide(html));
    let error = parsed.error || null;
    if (res.err) error = res.err;
    // 429 = сайт режет частоту. Помечаем как soft-block, чтобы схема "5 подряд →
    // прыжок на другую серию" сработала, а не копилось как parse_error.
    else if (res.status === 429) error = "Soft-blocked (HTTP 429 rate limit)";
    else if (res.status >= 400) error = `HTTP ${res.status}`;
    else if (blocked) error = parsed.error || "Blocked Price Guide page";
    return {
      ok,
      html,
      title,
      url: null,
      error,
      waitMs: 0,
      httpStatus: res.status,
    };
  }

  /** Sleep using current adaptive pause range; returns ms slept. */
  async pause() {
    const ms = randomInRange(this.pauseMin, this.pauseMax);
    await sleep(ms);
    return ms;
  }

  /** Expand pause back to configured base after blocks. */
  #expandPauseAfterBlock() {
    this.successStreak = 0;
    this.pauseMin = this.basePauseMin;
    this.pauseMax = this.basePauseMax;
  }

  /** Shrink pause toward adaptive floor after a success streak (disabled on CI without proxy). */
  #shrinkPauseAfterSuccess() {
    this.successStreak += 1;
    if (this.successStreak < ADAPTIVE_SHRINK_AFTER) return;
    if (!adaptivePauseEnabled(this.proxyUrl)) return;
    // Shrink toward floor even when BL_PAUSE_MS sets the base/ceiling.
    // WAF/soft-block paths still expand back to basePause via #expandPauseAfterBlock.
    this.pauseMin = Math.min(this.basePauseMin, ADAPTIVE_PAUSE_FLOOR[0]);
    this.pauseMax = Math.min(this.basePauseMax, ADAPTIVE_PAUSE_FLOOR[1]);
    if (this.pauseMax < this.pauseMin) this.pauseMax = this.pauseMin;
  }

  /** Longer pause after hard WAF / consecutive fails (not every soft_block). */
  async backoffAfterWaf() {
    const ms = 15000 + Math.floor(Math.random() * 15000);
    console.log(JSON.stringify({ step: "waf_backoff_ms", ms }));
    await sleep(ms);
    return ms;
  }

  async #softBlockCool() {
    const ms = randomInRange(SOFT_BLOCK_COOL_MS[0], SOFT_BLOCK_COOL_MS[1]);
    console.log(JSON.stringify({ step: "soft_block_cool_ms", ms }));
    await sleep(ms);
    return ms;
  }

  async #circuitCool() {
    const [lo, hi] = circuitCoolRange();
    let ms = randomInRange(lo, hi);
    // Мягкая эскалация: реальное восстановление — прыжок на другую серию номеров
    // (catalog_cool_mixed_bases), а не долгий сон. Держим потолок ~1.5×, не 3×.
    if (this.circuitTrips > 2) {
      const factor = Math.min(1.5, 1 + 0.25 * (this.circuitTrips - 2));
      ms = Math.round(ms * factor);
    }
    console.log(
      JSON.stringify({
        step: "circuit_cool_ms",
        ms,
        circuitTrips: this.circuitTrips,
        escalated: this.circuitTrips > 2,
      })
    );
    await sleep(ms);
    return ms;
  }

  async #hardRestartBrowser() {
    await this.close();
    await this.open();
    this.warmed = false;
    await this.warmUp();
  }

  /**
   * After scrape fails: soft_block cools the IP (continue window) unless BL_CIRCUIT_STOP=1;
   * hard WAF keeps short rewarm backoff.
   * @param {boolean} ok
   * @param {{ softBlocked?: boolean, hardWaf?: boolean }=} meta
   */
  async noteFetchOutcome(ok, meta = {}) {
    if (ok) {
      this.consecutiveFails = 0;
      this.consecutiveSoftBlocks = 0;
      this.circuitOpen = false;
      this.stopRequested = false;
      this.#shrinkPauseAfterSuccess();
      return 0;
    }
    this.#expandPauseAfterBlock();
    this.consecutiveFails += 1;

    if (meta.softBlocked) {
      this.consecutiveSoftBlocks += 1;
      if (this.consecutiveSoftBlocks >= CIRCUIT_SOFT_LIMIT) {
        this.circuitTrips += 1;
        if (circuitCoolAndContinue()) {
          this.circuitOpen = true;
          console.log(
            JSON.stringify({
              step: "circuit_cool_soft_block",
              consecutiveSoftBlocks: this.consecutiveSoftBlocks,
              circuitTrips: this.circuitTrips,
              action: "cool_and_continue",
            })
          );
          const ms = await this.#circuitCool();
          this.consecutiveSoftBlocks = 0;
          this.circuitOpen = false;
          this.stopRequested = false;
          this.warmed = false;
          // Rewarm only when a browser is already open (skip in unit tests / closed sessions).
          if (this.page) {
            try {
              await this.warmUp();
              await this.#syncHttpAuth();
            } catch (e) {
              console.warn("circuit cool rewarm failed:", e && e.message ? e.message : e);
            }
          }
          return ms;
        }
        this.circuitOpen = true;
        this.stopRequested = true;
        console.log(
          JSON.stringify({
            step: "circuit_open_soft_block",
            consecutiveSoftBlocks: this.consecutiveSoftBlocks,
            circuitTrips: this.circuitTrips,
            action: "stop_window",
          })
        );
      }
      return 0;
    }

    this.consecutiveSoftBlocks = 0;
    if (meta.hardWaf || this.consecutiveFails >= 3) {
      console.log(
        JSON.stringify({ step: "consecutive_fail_backoff", consecutiveFails: this.consecutiveFails })
      );
      const ms = await this.backoffAfterWaf();
      this.warmed = false;
      await this.warmUp();
      this.consecutiveFails = 0;
      return ms;
    }
    return 0;
  }

  /**
   * Fetch + parse one set Price Guide (reuses open session).
   * @param {string} setNoRaw
   * @param {{ returnHtml?: boolean, fastFail?: boolean, catalogPass?: boolean, itemType?: string, forceBrowser?: boolean }} opts
   *   Soft-block never cool+retries (was ~43s/item). catalogPass/fastFail skips hard-WAF depth too.
   *   forceBrowser / BL_HTTP_FETCH=0 → legacy Playwright navigation per set.
   */
  async fetchSet(setNoRaw, opts = {}) {
    if (this.stopRequested) {
      throw new Error("circuit_open_stop_window");
    }

    const totalStarted = Date.now();
    const timing = {
      pauseMs: 0,
      navMs: 0,
      waitMs: 0,
      backoffMs: 0,
      retries: 0,
    };

    const itemType = String(opts.itemType || "SET").toUpperCase();
    const setNo = normalizeItemNumber(setNoRaw, itemType) || normalizeSetNo(setNoRaw);
    if (!setNo) throw new Error("setNo is required");
    await this.warmUp();
    timing.pauseMs += await this.pause();

    const url = marketCatalogPgUrl(itemType, setNo);
    const useHttp = httpFetchEnabled() && !opts.forceBrowser;
    let result = await this.#fetchAndParse(url, setNo, opts, timing);
    const shallow = !!opts.fastFail || !!opts.catalogPass;

    if (isSoftBlockedResult(result)) {
      console.log(
        JSON.stringify({
          step: shallow ? "soft_block_catalog_pass" : "soft_block_one_shot",
          setNo,
          via: result.method,
        })
      );
    } else if (!shallow && isHardWafResult(result)) {
      this.#expandPauseAfterBlock();
      if (useHttp) {
        timing.retries += 1;
        result = await this.#gotoAndParse(url, setNo, opts, timing, BROWSER_FALLBACK_METHOD);
      } else {
        this.warmed = false;
        await this.warmUp();
        timing.pauseMs += await this.pause();
        timing.retries += 1;
        result = await this.#gotoAndParse(url, setNo, opts, timing);

        if (isHardWafResult(result) || result.parsed?.blocked) {
          await this.#hardRestartBrowser();
          timing.pauseMs += await this.pause();
          timing.retries += 1;
          result = await this.#gotoAndParse(url, setNo, opts, timing);
        }
      }

      if (result.parsed?.blocked && !result.parsed?.softBlocked) {
        timing.backoffMs += await this.backoffAfterWaf();
      }
    }

    const needsRetry =
      !shallow &&
      !result.parsed?.blocked &&
      !isSoftBlockedResult(result) &&
      !isHardWafResult(result) &&
      (!result.waitOk ||
        !result.parsed?.ok ||
        (!!result.parsed?.ok && !!result.parsed?.empty));

    if (needsRetry) {
      const reason = result.parsed?.error || result.waitError || (result.parsed?.empty ? "empty" : "retry");
      console.log(JSON.stringify({ step: "price_guide_retry", setNo, reason: String(reason).slice(0, 160) }));
      const cool = 2500 + Math.floor(Math.random() * 2000);
      timing.backoffMs += cool;
      await sleep(cool);
      timing.retries += 1;
      if (useHttp) {
        result = await this.#gotoAndParse(
          url,
          setNo,
          { ...opts, extraWaitMs: 8000 },
          timing,
          BROWSER_FALLBACK_METHOD
        );
      } else {
        result = await this.#gotoAndParse(url, setNo, { ...opts, extraWaitMs: 8000 }, timing);
      }

      if (
        !result.parsed?.ok &&
        !result.parsed?.blocked &&
        !hasPriceGuideContent(result.html || "")
      ) {
        console.log(JSON.stringify({ step: "price_guide_retry_hard", setNo }));
        await this.#hardRestartBrowser();
        timing.pauseMs += await this.pause();
        timing.retries += 1;
        result = await this.#gotoAndParse(
          url,
          setNo,
          { ...opts, extraWaitMs: 5000 },
          timing,
          useHttp ? BROWSER_FALLBACK_METHOD : BROWSER_METHOD
        );
      }
    }

    const success = !!(result.parsed?.ok && !result.parsed?.blocked);
    const softBlocked = isSoftBlockedResult(result);
    const hardWaf = !softBlocked && isHardWafResult(result);
    timing.backoffMs += await this.noteFetchOutcome(success, { softBlocked, hardWaf });

    if (!success) {
      const tag = classifyErrorTag(result.parsed, result.waitError);
      result.errorTag = tag;
      if (result.html) {
        const dumpPath = dumpFailureHtml(setNo, result.html, tag);
        if (dumpPath) result.htmlDumpPath = dumpPath;
      }
    } else {
      result.errorTag = null;
    }

    const totalMs = Date.now() - totalStarted;
    result.timing = {
      pauseMs: timing.pauseMs,
      navMs: timing.navMs,
      waitMs: timing.waitMs,
      backoffMs: timing.backoffMs,
      retries: timing.retries,
      totalMs,
    };
    console.log(
      JSON.stringify({
        step: "fetch_timing",
        setNo,
        errorTag: result.errorTag || (success ? "ok" : "unknown"),
        ...result.timing,
      })
    );

    if (!opts.returnHtml) delete result.html;

    return result;
  }

  async #fetchAndParse(url, setNo, opts, timing) {
    if (httpFetchEnabled() && !opts.forceBrowser) {
      return this.#httpFetchAndParse(url, setNo, opts, timing);
    }
    return this.#gotoAndParse(url, setNo, opts, timing);
  }

  async #httpFetchAndParse(url, setNo, opts, timing) {
    if (!this.httpCookieHeader) await this.#syncHttpAuth();

    let res = await this.#httpGet(url);
    if (timing) timing.navMs += res.ms;

    // В каталоге (shallow) на 429 не ждём вообще — сразу soft-block и следующий набор.
    // Глубокий повтор — только в ручном/Pro режиме (retry-errors).
    const shallow = !!opts.catalogPass || !!opts.fastFail;
    const max429Retries = shallow
      ? 0
      : Math.max(0, Number(process.env.BL_HTTP_429_RETRIES || 1) || 1);
    let attempts429 = 0;
    while (res.status === 429 && attempts429 < max429Retries) {
      attempts429 += 1;
      if (timing) {
        timing.retries += 1;
        timing.backoffMs += await this.#rateLimitBackoff();
      } else {
        await this.#rateLimitBackoff();
      }
      await this.#refreshHttpToken();
      const retry = await this.#httpGet(url);
      if (timing) timing.navMs += retry.ms;
      res = retry;
      console.log(
        JSON.stringify({
          step: "http_429_retry",
          setNo,
          attempt: attempts429,
          status: res.status,
        })
      );
    }

    let waited = this.#packHttpWaited(res, res.html || "");
    let parsed = parseCatalogPgHtml(waited.html || "");
    let result = this.#pack(setNo, url, waited, parsed, opts, HTTP_METHOD);

    // Stale token → one refresh + retry before counting as soft-block.
    if (
      (res.status === 403 || isHardWafResult(result) || (parsed.blocked && !parsed.softBlocked)) &&
      res.status !== 429
    ) {
      console.log(JSON.stringify({ step: "http_token_refresh", setNo, status: res.status }));
      if (timing) timing.retries += 1;
      await this.#refreshHttpToken();
      const retry = await this.#httpGet(url);
      if (timing) timing.navMs += retry.ms;
      waited = this.#packHttpWaited(retry, retry.html || "");
      parsed = parseCatalogPgHtml(waited.html || "");
      result = this.#pack(setNo, url, waited, parsed, opts, HTTP_METHOD);
    }

    return result;
  }

  async #gotoAndParse(url, setNo, opts, timing, method = BROWSER_METHOD) {
    const navStarted = Date.now();
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    const navMs = Date.now() - navStarted;
    if (timing) timing.navMs += navMs;

    const waited = await waitForPriceGuide(this.page, this.timeoutMs);
    if (timing) timing.waitMs += waited.waitMs || 0;

    if (opts.extraWaitMs) await sleep(Number(opts.extraWaitMs) || 0);
    const html = opts.extraWaitMs ? await this.page.content() : waited.html || "";
    const parsed = parseCatalogPgHtml(html || waited.html || "");
    return this.#pack(setNo, url, { ...waited, html: html || waited.html }, parsed, opts, method);
  }

  /**
   * @param {string[]} setNos
   * @param {{ returnHtml?: boolean, onItem?: Function }} opts
   */
  async fetchMany(setNos, opts = {}) {
    const out = [];
    for (const raw of setNos) {
      const result = await this.fetchSet(raw, opts);
      out.push(result);
      if (typeof opts.onItem === "function") await opts.onItem(result);
    }
    return out;
  }

  #pack(setNo, url, waited, parsed, opts, method = BROWSER_METHOD) {
    return {
      setNo,
      url,
      finalUrl: waited.url || url,
      title: waited.title || null,
      challengeCleared: !isWafChallengePage(waited.html || ""),
      waitOk: !!waited.ok,
      waitError: waited.error || null,
      htmlBytes: (waited.html || "").length,
      httpStatus: waited.httpStatus || null,
      // Kept internally so fetchSet() can dump it to disk on failure; stripped before
      // returning unless the caller explicitly asked for it via opts.returnHtml.
      html: waited.html,
      parsed,
      fetchedAt: new Date().toISOString(),
      method,
    };
  }

  async close() {
    try {
      if (this.browser) await this.browser.close();
    } catch {
      //
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.warmed = false;
    this.httpCookieHeader = null;
  }
}

module.exports = {
  CollectorSession,
  waitForPriceGuide,
  DEFAULT_TIMEOUT_MS,
  defaultPauseMs,
  classifyErrorTag,
  dumpFailureHtml,
  parseProxyUrl,
  isSoftBlockedResult,
  isHardWafResult,
  adaptivePauseEnabled,
  httpFetchEnabled,
  cookieHeaderFromPlaywright,
  circuitCoolAndContinue,
  circuitCoolRange,
  ADAPTIVE_PAUSE_FLOOR,
  SOFT_BLOCK_COOL_MS,
  SOFT_BLOCK_FAST_MS,
  CIRCUIT_SOFT_LIMIT,
  HTTP_METHOD,
  BROWSER_METHOD,
  BROWSER_FALLBACK_METHOD,
};
