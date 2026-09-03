/**
 * Cloud Run worker: warm Playwright session + on-demand price refresh.
 *
 * POST /v1/refresh  { "catalogItemId": "SET_75192-1" }
 * Header: Authorization: Bearer <REFRESH_WORKER_TOKEN>
 * GET  /health
 *
 * Returns 202 immediately and scrapes in-background (requires Cloud Run
 * --no-cpu-throttling / CPU always allocated so work continues after response).
 */
"use strict";

const express = require("express");
const { initFirebaseAdmin } = require("../firebaseAdmin");
const { BrickLinkSession } = require("../session");
const { processOne, resolvePriorityItem } = require("../ingestQueue");

const PORT = Number(process.env.PORT || 8080) || 8080;
const TOKEN = String(process.env.REFRESH_WORKER_TOKEN || "").trim();

const app = express();
app.use(express.json({ limit: "32kb" }));

let adminBundle = null;
let session = null;
let warmPromise = null;
let inFlight = 0;
const refreshQueue = [];
let pumping = false;

function requireAuth(req, res, next) {
  if (!TOKEN) {
    return res.status(503).json({ ok: false, error: "worker_token_not_configured" });
  }
  const hdr = String(req.headers.authorization || "");
  const got = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (got !== TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

function getAdmin() {
  if (!adminBundle) adminBundle = initFirebaseAdmin();
  return adminBundle;
}

async function getWarmSession() {
  if (session && session.page) return session;
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    if (session) {
      try {
        await session.close();
      } catch {
        //
      }
    }
    session = new BrickLinkSession({ headless: true });
    await session.open();
    await session.warmUp();
    return session;
  })();
  try {
    return await warmPromise;
  } finally {
    warmPromise = null;
  }
}

function isWafLikeError(err) {
  return /waf|soft.?block|challenge|Access Denied/i.test(String(err || ""));
}

async function dispatchGithubRefresh(catalogItemId) {
  const token = String(process.env.GITHUB_PAT || process.env.GH_PAT || "").trim();
  const repo = String(process.env.GITHUB_REPO || "BrickInFuture/BrickInFuture").trim();
  if (!token || !repo.includes("/")) {
    return { ok: false, reason: "github_not_configured" };
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "BrickInFuture-refresh-worker",
      },
      body: JSON.stringify({
        event_type: "bricklink-price-refresh",
        client_payload: { catalogItemId: String(catalogItemId) },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(JSON.stringify({
        step: "gha_dispatch_fail",
        status: res.status,
        body: body.slice(0, 200),
      }));
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function fallbackWafToGithub(db, FieldValue, catalogItemId, err) {
  const gha = await dispatchGithubRefresh(catalogItemId);
  await db.collection("price_refresh_requests").doc(catalogItemId).set(
    {
      status: gha.ok ? "running" : "error",
      error: gha.ok ? "waf_fallback_gha" : `waf_gha_dispatch_failed:${gha.reason || "unknown"}`,
      resultStatus: gha.ok ? null : "error",
      dispatchTriggered: !!gha.ok,
      updatedAt: FieldValue.serverTimestamp(),
      finishedAt: gha.ok ? null : FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(JSON.stringify({
    step: "waf_fallback_gha",
    catalogItemId,
    dispatched: gha.ok,
    reason: gha.reason || null,
  }));
  return gha;
}

async function runRefresh(catalogItemId) {
  inFlight += 1;
  const started = Date.now();
  try {
    const { admin, db, FieldValue } = getAdmin();
    const reqRow = await resolvePriorityItem(db, FieldValue, catalogItemId);
    const sess = await getWarmSession();
    const summary = [];
    await processOne(admin, db, FieldValue, sess, reqRow, summary);
    const row = summary[0] || { catalogItemId, ok: false, error: "no_summary" };
    console.log(JSON.stringify({ step: "refresh_done", ms: Date.now() - started, ...row }));
    if (!row.ok && isWafLikeError(row.error)) {
      await fallbackWafToGithub(db, FieldValue, catalogItemId, row.error);
    }
    return row;
  } catch (e) {
    console.error("refresh_failed", catalogItemId, e);
    try {
      if (session) await session.close();
    } catch {
      //
    }
    session = null;
    if (isWafLikeError(e.message || e)) {
      try {
        const { db, FieldValue } = getAdmin();
        await fallbackWafToGithub(db, FieldValue, catalogItemId, e.message || e);
      } catch (fallbackErr) {
        console.error("waf_fallback_failed", fallbackErr);
      }
    }
    throw e;
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

function startPump() {
  if (pumping) return;
  pumping = true;
  setImmediate(() => {
    pumpRefreshQueue().catch((e) => {
      pumping = false;
      console.error(JSON.stringify({ step: "refresh_pump_fail", error: String(e.message || e).slice(0, 500) }));
      if (refreshQueue.length) startPump();
    });
  });
}

function enqueueRefresh(catalogItemId) {
  refreshQueue.push(catalogItemId);
  startPump();
}

async function pumpRefreshQueue() {
  try {
    while (refreshQueue.length) {
      const catalogItemId = refreshQueue.shift();
      try {
        await runRefresh(catalogItemId);
      } catch (e) {
        console.error(JSON.stringify({
          step: "refresh_bg_fail",
          catalogItemId,
          error: String(e.message || e).slice(0, 500),
        }));
      }
    }
  } finally {
    pumping = false;
    if (refreshQueue.length) startPump();
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    warm: !!(session && session.page),
    inFlight,
    queued: refreshQueue.length,
  });
});

app.post("/v1/refresh", requireAuth, async (req, res) => {
  const catalogItemId = String(req.body?.catalogItemId || "").trim();
  if (!catalogItemId) {
    return res.status(400).json({ ok: false, error: "catalogItemId_required" });
  }

  // Accept fast; scrape continues after response (CPU always-on on Cloud Run).
  // Serial queue: one Playwright page per instance — do not overlap scrapes.
  enqueueRefresh(catalogItemId);
  res.status(202).json({
    ok: true,
    accepted: true,
    catalogItemId,
    queued: refreshQueue.length + (inFlight > 0 ? 1 : 0),
  });
});

app.listen(PORT, () => {
  console.log(JSON.stringify({ step: "worker_listen", port: PORT }));
  getWarmSession()
    .then(() => console.log(JSON.stringify({ step: "worker_warm_ok" })))
    .catch((e) =>
      console.error(JSON.stringify({ step: "worker_warm_fail", error: String(e.message || e) }))
    );
});
