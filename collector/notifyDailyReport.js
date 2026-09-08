/**
 * Дневной отчёт парсера → Telegram (один раз в 23:59 Ереван).
 *
 *   node collector/notifyDailyReport.js
 *
 * Цифры только из накопительных счётчиков (parserStats), без полного скана.
 */
"use strict";

const fs = require("fs");
const { initFirebaseAdmin } = require("./firebaseAdmin");
const { utcYearMonth } = require("./gapLedger");
const { readParserStats, REPORT_TZ, yerevanDayId } = require("./parserStats");
const { readMonthQueueMeta } = require("./monthQueue");
const { formatReportDateRu, periodIdRu } = require("./notifyIngestReport");

const SUCCESS_PCT_TARGET = 90;
const WARN_PCT = 70;
const DAY_TARGET = Math.max(1, Number(process.env.BL_OK_PER_DAY_TARGET) || 1150);
const MONTH_TARGET = Math.max(1, Number(process.env.BL_MONTH_UNIQUE_TARGET) || 30000);

function n(v) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  return String(v);
}

function pct(got, req) {
  const g = Number(got);
  const r = Number(req);
  if (!Number.isFinite(g) || !Number.isFinite(r) || r <= 0) return null;
  return Math.round((g / r) * 1000) / 10;
}

function successMark(gotPct) {
  if (gotPct == null) return "⚪";
  if (gotPct >= SUCCESS_PCT_TARGET) return "🟢";
  if (gotPct >= WARN_PCT) return "🟡";
  return "🔴";
}

function sourceTitle(key) {
  if (key === "brickowl") return "Brick Owl";
  return "BrickLink";
}

function formatSourceBlock(key, bucket, catalogPrimary) {
  const req = Number(bucket.dayRequested) || 0;
  const got = Number(bucket.dayGotPrice) || 0;
  const empty = Number(bucket.dayEmpty) || 0;
  const err = Number(bucket.dayErrors) || 0;
  const soft = Number(bucket.daySoftBlocked) || 0;
  const monthGot = Number(bucket.monthGotPrice) || 0;
  const unique = Number(bucket.monthUniquePriced) || 0;
  const gotPct = pct(got, req);
  const mark = successMark(gotPct);
  const coverPct =
    catalogPrimary > 0 && Number.isFinite(unique)
      ? Math.round((unique / catalogPrimary) * 1000) / 10
      : null;

  const lines = [
    `Источник: ${sourceTitle(key)} ${mark}`,
    `• запросили: ${n(req)}`,
    `• получили цену: ${n(got)}${gotPct != null ? ` (${gotPct}%)` : ""}`,
    `• пусто: ${n(empty)}`,
    `• ошибки (в хвост месяца): ${n(err)}`,
  ];
  if (soft > 0) lines.push(`• сайт резал частоту: ${n(soft)}`);
  lines.push(`• за месяц с этого источника получено цен: ${n(monthGot)}`);
  lines.push(
    `• наборов со свежей ценой месяца: ${n(unique)} из ${n(catalogPrimary)}${
      coverPct != null ? ` (${coverPct}%)` : ""
    }`
  );
  return lines;
}

function buildVerdict(stats, queueRemainingBl) {
  const bl = stats.bySource.bricklink || {};
  const owl = stats.bySource.brickowl || {};
  const dayGot = (Number(bl.dayGotPrice) || 0) + (Number(owl.dayGotPrice) || 0);
  const dayReq = (Number(bl.dayRequested) || 0) + (Number(owl.dayRequested) || 0);
  const soft =
    (Number(bl.daySoftBlocked) || 0) +
    (Number(owl.daySoftBlocked) || 0) +
    (Number(bl.softBlocked) || 0); // month soft for context if day zero
  const daySoft = (Number(bl.daySoftBlocked) || 0) + (Number(owl.daySoftBlocked) || 0);
  const uniqueBl = Number(bl.monthUniquePriced) || 0;
  const uniqueOwl = Number(owl.monthUniquePriced) || 0;
  // Уникальные «с ценой месяца» в отчёте по источникам раздельно; для темпа берём BL (основной объём).
  const unique = uniqueBl;
  const catalog = Number(stats.catalogPrimary) || 0;

  const now = new Date();
  const utcDay = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", day: "2-digit" }).format(now)
  );
  const daysLeft = Math.max(1, 26 - utcDay + 1);
  const needPerDay = Math.ceil(Math.max(0, MONTH_TARGET - unique) / daysLeft);
  const remaining = Number(queueRemainingBl);
  const gotPct = pct(dayGot, dayReq);

  let paceEmoji = "🟢";
  let paceText = "успеваем по этому месяцу";
  if (remaining > daysLeft * DAY_TARGET * 1.2 || needPerDay > DAY_TARGET * 1.3) {
    paceEmoji = "🔴";
    paceText = "отстаём по этому месяцу";
  } else if (remaining > daysLeft * DAY_TARGET * 0.85 || needPerDay > DAY_TARGET) {
    paceEmoji = "🟡";
    paceText = "на грани — темп надо держать";
  }

  let blockEmoji = "🟢";
  let blockText = "блокировок мало";
  if (daySoft >= 20 || (gotPct != null && gotPct < WARN_PCT && dayReq >= 20)) {
    blockEmoji = "🔴";
    blockText = "сильно режут / много пустых";
  } else if (daySoft >= 5 || (gotPct != null && gotPct < SUCCESS_PCT_TARGET && dayReq >= 20)) {
    blockEmoji = "🟡";
    blockText = "сайт иногда режет";
  }

  return [
    "",
    `Вывод: ${paceEmoji} ${paceText}`,
    `• очередь BL осталось: ${Number.isFinite(remaining) ? remaining : "—"} · нужно ~${needPerDay}/день`,
    `• уникальных с ценой месяца (BL): ${unique}${catalog > 0 ? ` из ${catalog}` : ""}`,
    `• Owl уникальных за месяц: ${uniqueOwl}`,
    `${blockEmoji} ${blockText} · блокировок за день: ${daySoft}`,
  ];
}

function buildDailyReportText(stats, opts = {}) {
  const when = formatReportDateRu(new Date(), REPORT_TZ);
  const monthNom = periodIdRu(stats.periodId, "nominative");
  const catalog = Number(stats.catalogPrimary);
  const lines = [
    "📊 Парсер цен — дневной отчёт",
    when,
    `(Ереван · ${monthNom})`,
    "",
    ...formatSourceBlock("bricklink", stats.bySource.bricklink || {}, catalog),
    "",
    ...formatSourceBlock("brickowl", stats.bySource.brickowl || {}, catalog),
    ...buildVerdict(stats, opts.queueRemainingBl),
  ];
  if (opts.runUrl) {
    lines.push("", `Лог: ${opts.runUrl}`);
  }
  return lines.join("\n");
}

async function sendTelegram(text) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    console.log("Telegram: secrets not set — skip");
    return { ok: false, reason: "no_telegram_secrets" };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true) {
    console.error("Telegram send failed:", res.status, body);
    return { ok: false, reason: "telegram_http", status: res.status, body };
  }
  console.log("Telegram: sent");
  return { ok: true };
}

async function main() {
  const { db } = initFirebaseAdmin();
  const periodId = utcYearMonth();
  const stats = await readParserStats(db, periodId);
  let queueRemainingBl = null;
  try {
    const meta = await readMonthQueueMeta(db, periodId, "bricklink");
    if (meta) queueRemainingBl = Number(meta.remaining);
  } catch (e) {
    console.warn("queue meta read failed:", e && e.message ? e.message : e);
  }
  const text = buildDailyReportText(stats, {
    queueRemainingBl,
    runUrl: process.env.GITHUB_RUN_URL || "",
  });
  console.log("\n--- daily parser report ---\n" + text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Дневной отчёт\n\`\`\`\n${text}\n\`\`\`\n`,
      "utf8"
    );
  }
  const tg = await sendTelegram(text);
  if (!tg.ok && tg.reason === "no_telegram_secrets") process.exitCode = 0;
  else if (!tg.ok) process.exitCode = 1;
}

module.exports = {
  buildDailyReportText,
  formatSourceBlock,
  buildVerdict,
  successMark,
  SUCCESS_PCT_TARGET,
  WARN_PCT,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
