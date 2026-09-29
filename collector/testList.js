"use strict";

const fs = require("fs");
const path = require("path");

const USE_PROXY = process.env.TEST_USE_PROXY === "1";
if (!USE_PROXY) delete process.env.BL_PROXY_URL;
const PROXY_URL = USE_PROXY ? String(process.env.BL_PROXY_URL || "").trim() : "";

const { initFirebaseAdmin } = require("./firebaseAdmin");
const { fetchViaProxy } = require("./httpProxy");
const { CollectorSession } = require("./session");
const { writeObservationFromParse } = require("./observationWriter");
const { resolveMarketFetch } = require("./blUrls");

const { admin, db } = initFirebaseAdmin();

function readList() {
  return fs
    .readFileSync(path.join(__dirname, "test-list.txt"), "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasPrice(p) {
  return ["soldNew", "soldUsed", "stockNew", "stockUsed"].some((k) => Number(p?.[k]?.qtyAvgUsd) > 0);
}

async function sendTelegram(text) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    console.log("Telegram: secrets not set");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  console.log("Telegram:", res.status);
}

function fmtMin(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} мин ${s % 60} с`;
}

async function exitIp() {
  try {
    const res = PROXY_URL
      ? await fetchViaProxy("https://api.ipify.org", { proxyUrl: PROXY_URL })
      : await fetch("https://api.ipify.org");
    return (await res.text()).trim().slice(0, 64);
  } catch (e) {
    return `не узнал (${String(e.message || e).slice(0, 80)})`;
  }
}

async function main() {
  if (USE_PROXY && !PROXY_URL) throw new Error("BL_PROXY_URL пустой");
  const list = readList();
  const ipBefore = await exitIp();
  const started = Date.now();
  const stats = { total: list.length, withPrice: 0, empty: 0, soft: 0, waf: 0, other: 0, skipped: 0 };
  const failed = [];
  const session = new CollectorSession({ headless: true, proxyUrl: PROXY_URL });
  let fatal = null;

  try {
    await session.warmUp();
    for (let i = 0; i < list.length; i++) {
      const setNo = list[i];
      const snap = await db.collection("catalog_items").doc(`SET_${setNo}`).get();
      if (!snap.exists) {
        stats.skipped++;
        failed.push(`${setNo} нет в базе`);
        continue;
      }
      const cat = snap.data();
      const spec = resolveMarketFetch(cat);
      if (spec.skip || !spec.itemNumber) {
        stats.skipped++;
        failed.push(`${setNo} пропуск (${spec.reason || "no_lookup"})`);
        continue;
      }
      const fetchNo = spec.itemNumber;
      const fetchType = spec.itemType || "SET";
      let scrape;
      try {
        scrape = await session.fetchSet(fetchNo, { itemType: fetchType, catalogPass: true });
      } catch (e) {
        scrape = { parsed: { ok: false, error: String(e.message || e) }, errorTag: "exception" };
      }
      const ok = !!scrape.parsed?.ok;
      if (ok) {
        if (hasPrice(scrape.parsed)) stats.withPrice++;
        else stats.empty++;
      } else {
        const tag = scrape.errorTag || "";
        if (tag === "soft_blocked") stats.soft++;
        else if (tag === "waf_blocked") stats.waf++;
        else stats.other++;
        failed.push(`${setNo} ${tag || scrape.parsed?.error || scrape.waitError || "ошибка"}`);
      }
      await writeObservationFromParse(
        db,
        admin.firestore,
        {
          catalogItemId: snap.id,
          itemType: "SET",
          setNo: fetchNo,
          parsed: scrape.parsed || { ok: false, error: scrape.waitError },
          method: scrape.method,
          errorTag: ok ? undefined : scrape.errorTag || null,
        },
        { writeBif: false, dryRun: false }
      );
      console.log(`${i + 1}/${list.length} ${setNo} ok=${ok} tag=${scrape.errorTag || ""}`);
    }
  } catch (e) {
    fatal = e;
    console.error(e);
  } finally {
    await session.close().catch(() => {});
  }

  const dur = Date.now() - started;
  const ipAfter = await exitIp();
  const done = stats.withPrice + stats.empty;
  const tried = stats.total - stats.skipped;
  const lines = [
    "🧪 Тестовый прогон ТЕСТ_ПРОКСИ",
    USE_PROXY
      ? "🛡 С ПРОКСИ (GitHub Actions через DataImpulse)"
      : "⚠️ БЕЗ ПРОКСИ (GitHub Actions, обычный IP GitHub)",
    `IP в начале: ${ipBefore}`,
    `IP в конце: ${ipAfter}`,
    "",
    `Наборов в списке: ${stats.total}`,
    `С ценой: ${stats.withPrice}`,
    `Пусто (сделок и витрины нет): ${stats.empty}`,
    `Блок сайта (Oops): ${stats.soft}`,
    `Жёсткий блок: ${stats.waf}`,
    `Другие ошибки: ${stats.other}`,
    stats.skipped ? `Пропущено: ${stats.skipped}` : null,
    "",
    `Успешно: ${done} из ${tried} (${tried ? Math.round((done / tried) * 100) : 0}%)`,
    `Время: ${fmtMin(dur)}${done ? `, ~${Math.round(dur / 1000 / done)} с на набор` : ""}`,
    fatal ? `\n❌ Прогон упал: ${String(fatal.message || fatal).slice(0, 200)}` : null,
    failed.length
      ? `\nНе вышло:\n${failed.slice(0, 25).join("\n")}${failed.length > 25 ? `\n…и ещё ${failed.length - 25}` : ""}`
      : null,
    process.env.GITHUB_RUN_URL ? `\n${process.env.GITHUB_RUN_URL}` : null,
  ].filter((l) => l !== null);

  const text = lines.join("\n");
  console.log("\n" + text);
  await sendTelegram(text);
}

main().catch(async (e) => {
  console.error(e);
  await sendTelegram(
    `🧪 ТЕСТ_ПРОКСИ (${USE_PROXY ? "с прокси" : "без прокси"}, GitHub) упал до старта: ${String(e.message || e).slice(0, 300)}`
  );
  process.exit(1);
});
