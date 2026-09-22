/**
 * HTTP(S) proxy helper for catalog fetch (BL + Owl).
 * Uses undici ProxyAgent when BL_PROXY_URL / BO_PROXY_URL is set.
 * Playwright warm-up still uses its own proxy config in session.js.
 */
"use strict";

function parseProxyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    const port = u.port ? `:${u.port}` : "";
    const out = { server: `${u.protocol}//${u.hostname}${port}`, href: withScheme };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return null;
  }
}

function proxyEnvUrl() {
  return String(process.env.BL_PROXY_URL || process.env.BO_PROXY_URL || "").trim();
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
  parseProxyUrl,
  proxyEnvUrl,
  getProxyDispatcher,
  fetchViaProxy,
};
