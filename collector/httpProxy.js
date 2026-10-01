/**
 * HTTP(S) proxy helper for catalog fetch (BL + Owl).
 * Uses undici ProxyAgent when BL_PROXY_URL / BO_PROXY_URL is set.
 * Playwright warm-up still uses its own proxy config in session.js.
 */
"use strict";

/** Accepts provider "host:port:user:pass" and bare "user:pass@host:port" besides full URLs. */
function normalizeProxyInput(raw) {
  const s = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  const parts = s.split(":");
  if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(":"))}@${host}:${port}`;
  }
  return s;
}

/**
 * Price Guide renders in the exit IP's local currency and we only parse USD,
 * so a residential gateway without an explicit country gets pinned to BL_PROXY_COUNTRY (default us).
 */
function pinProxyCountry(u) {
  const country = String(process.env.BL_PROXY_COUNTRY ?? "us").trim().toLowerCase();
  if (!country || country === "0" || !u.username) return;
  if (!/(^|\.)dataimpulse\.com$/i.test(u.hostname)) return;
  const user = decodeURIComponent(u.username);
  if (/__cr\./i.test(user)) return;
  const semi = user.indexOf(";");
  const next = semi >= 0
    ? `${user.slice(0, semi)}__cr.${country}${user.slice(semi)}`
    : `${user}__cr.${country}`;
  u.username = encodeURIComponent(next);
}

function parseProxyUrl(raw) {
  const s = normalizeProxyInput(raw);
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    if (!u.hostname) return null;
    pinProxyCountry(u);
    const withScheme = u.href.replace(/\/$/, "");
    const port = u.port ? `:${u.port}` : "";
    const out = { server: `${u.protocol}//${u.hostname}${port}`, href: withScheme };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return null;
  }
}

/** null = env; "" = direct (no proxy); otherwise this URL (e.g. a rotated sticky port). */
let proxyUrlOverride = null;

function setProxyUrlOverride(url) {
  proxyUrlOverride = url == null ? null : String(url).trim();
}

function proxyEnvUrl() {
  if (proxyUrlOverride !== null) return proxyUrlOverride;
  return String(process.env.BL_PROXY_URL || process.env.BO_PROXY_URL || "").trim();
}

/** Sticky gateway: each port in this range holds its own residential IP. */
function proxyPortRange() {
  const m = String(process.env.BL_PROXY_PORT_RANGE || "10000-20000").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return hi > lo ? [lo, hi] : null;
}

/** Same proxy URL with another sticky port, or null when rotation does not apply. */
function withRandomProxyPort(raw) {
  if (process.env.BL_PROXY_ROTATE === "0") return null;
  const range = proxyPortRange();
  const src = String(raw || "").trim();
  const m = src.match(/:(\d{2,5})(\/?)$/);
  if (!range || !m) return null;
  const port = Number(m[1]);
  if (port < range[0] || port > range[1]) return null;
  let next = port;
  while (next === port) next = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  return `${src.slice(0, m.index)}:${next}${m[2]}`;
}

/**
 * Parallel bursts get their own BL_PROXY_PORT_RANGE slice: start on a random port inside it,
 * otherwise every shard begins on the secret's port and rotation refuses an out-of-range port.
 */
function startPortInOwnRange(raw) {
  const src = String(raw || "").trim();
  if (!String(process.env.BL_PROXY_PORT_RANGE || "").trim() || process.env.BL_PROXY_ROTATE === "0") {
    return src;
  }
  const range = proxyPortRange();
  const m = src.match(/:(\d{2,5})(\/?)$/);
  if (!range || !m) return src;
  const port = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  return `${src.slice(0, m.index)}:${port}${m[2]}`;
}

let cachedAgent = null;
let cachedAgentKey = null;

function getProxyDispatcher(explicitUrl) {
  const raw = String(explicitUrl != null ? explicitUrl : proxyEnvUrl()).trim();
  if (!raw) return null;
  if (cachedAgent && cachedAgentKey === raw) return cachedAgent;
  const parsed = parseProxyUrl(raw);
  if (!parsed) return null;
  try {
    const { ProxyAgent } = require("undici");
    cachedAgent = new ProxyAgent(parsed.href);
    cachedAgentKey = raw;
    return cachedAgent;
  } catch (e) {
    console.warn(
      "httpProxy: undici ProxyAgent unavailable",
      e && e.message ? e.message : e
    );
    return null;
  }
}

/**
 * fetch with optional proxy dispatcher (Node undici).
 * Falls back to global fetch when no proxy / agent unavailable.
 */
async function fetchViaProxy(url, opts = {}) {
  const dispatcher = getProxyDispatcher(opts.proxyUrl);
  const init = { ...opts };
  delete init.proxyUrl;
  if (dispatcher) init.dispatcher = dispatcher;
  return fetch(url, init);
}

module.exports = {
  normalizeProxyInput,
  parseProxyUrl,
  proxyEnvUrl,
  getProxyDispatcher,
  fetchViaProxy,
  proxyPortRange,
  withRandomProxyPort,
  startPortInOwnRange,
  setProxyUrlOverride,
};
