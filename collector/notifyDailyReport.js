/**
 * Дневной отчёт парсера → Telegram (один раз в 23:59 Ереван).
 *
 *   node collector/notifyDailyReport.js
 *
 * Дёшево: 1 документ счётчиков + 2 меты очередей + счётчики (count) каталога и очередей
 * повтора — порядка 50 чтений на отчёт, без обхода наблюдений.
 */
"use strict";

const fs = require("fs");
const { initFirebaseAdmin } = require("./firebaseAdmin");
const { utcYearMonth } = require("./gapLedger");
const { readParserStats, REPORT_TZ, yerevanDayId, emptyAttempts } = require("./parserStats");
const { readMonthQueueMeta, queueRef } = require("./monthQueue");
const { periodIdRu } = require("./notifyIngestReport");

const REPORT_TYPES = [
  ["SET", "Наборы"],
  ["MINIFIG", "Минифигурки"],
  ["GEAR", "Сувениры"],
  ["OTHER", "Прочее"],
];
const SOURCE_TITLES = { bricklink: "BrickLink", brickowl: "Brick Owl" };
const MAIN_SOURCE = "bricklink";
/** До этого часа по Еревану отчёт считается за вчера (запуск в 23:59 мог уехать за полночь). */
const LATE_RUN_HOUR = 6;

function fmt(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "—";
  return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function pct(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return null;
  return Math.round((x / y) * 1000) / 10;
}

function yerevanHour(date) {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: REPORT_TZ, hour: "2-digit", hour12: false }).format(date)
  );
}

/** За какой день Еревана отчёт: после полуночи до 06:00 — за вчера. */
function reportDayId(now = new Date()) {
  if (yerevanHour(now) < LATE_RUN_HOUR) {
    return yerevanDayId(new Date(now.getTime() - LATE_RUN_HOUR * 60 * 60 * 1000));
  }
  return yerevanDayId(now);
}

function dayIdRu(dayId) {
  const [y, m, d] = String(dayId).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(date);
}

/** Дней до конца месяца (UTC), считая день отчёта. */
function daysLeftInMonth(dayId) {
  const [y, m, d] = String(dayId).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.max(1, last - d + 1);
}

function dayAttempts(bucket, dayId) {
  const fromHistory = bucket && bucket.days && bucket.days[dayId];
  if (fromHistory) return { ...emptyAttempts(), ...fromHistory };
  if (bucket && String(bucket.yerevanDay || "") === dayId) {
    return {
      requested: Number(bucket.dayRequested) || 0,
      gotPrice: Number(bucket.dayGotPrice) || 0,
      empty: Number(bucket.dayEmpty) || 0,
      errors: Number(bucket.dayErrors) || 0,
      softBlocked: Number(bucket.daySoftBlocked) || 0,
    };
  }
  return emptyAttempts();
}

function monthAttempts(bucket) {
  const byType = (bucket && bucket.monthByType) || {};
  if (Object.keys(byType).length) {
    const t = emptyAttempts();
    for (const row of Object.values(byType)) {
      for (const f of Object.keys(t)) t[f] += Number(row[f]) || 0;
    }
    return t;
  }
  return {
    requested: Number(bucket?.monthRequested) || 0,
    gotPrice: Number(bucket?.monthGotPrice) || 0,
    empty: Number(bucket?.monthEmpty) || 0,
    errors: Number(bucket?.monthErrors) || 0,
    softBlocked: Number(bucket?.softBlocked) || 0,
  };
}

function uniqueAnswered(bucket) {
  let n = 0;
  for (const row of Object.values((bucket && bucket.monthUniqueByType) || {})) {
    n += (Number(row.priced) || 0) + (Number(row.empty) || 0);
  }
  return n;
}

function formatDayLine(key, a) {
  const parts = [
    `запросов ${fmt(a.requested)}`,
    `цена ${fmt(a.gotPrice)}`,
    `пусто ${fmt(a.empty)}`,
    `ошибки ${fmt(a.errors)}`,
  ];
  if (a.softBlocked > 0) parts.push(`сайт резал ${fmt(a.softBlocked)}`);
  return `${SOURCE_TITLES[key]}: ${parts.join(" · ")}`;
}

function formatMonthBlock(key, bucket, catalogByType, queue) {
  const a = monthAttempts(bucket);
  const lines = [
    `За месяц · ${SOURCE_TITLES[key]}`,
    `Попыток: ${fmt(a.requested)} · ошибки ${fmt(a.errors)} · сайт резал ${fmt(a.softBlocked)}`,
  ];
  const uniq = (bucket && bucket.monthUniqueByType) || {};
  const attemptsByType = (bucket && bucket.monthByType) || {};
  for (const [type, title] of REPORT_TYPES) {
    const u = uniq[type] || {};
    const priced = Number(u.priced) || 0;
    const empty = Number(u.empty) || 0;
    const total = catalogByType ? Number(catalogByType[type]) : NaN;
    const tries = Number(attemptsByType[type]?.requested) || 0;
    if (type === "OTHER" && !priced && !empty && !tries) continue;
    const answered = priced + empty;
    const share = Number.isFinite(total) && total > 0 ? pct(answered, total) : null;
    const parts = [];
    if (tries) parts.push(`попыток ${fmt(tries)}`);
    parts.push(`цена ${fmt(priced)}`, `пусто ${fmt(empty)}`);
    parts.push(
      `с ответом ${fmt(answered)}${Number.isFinite(total) && total > 0 ? ` из ${fmt(total)}` : ""}${
        share != null ? ` (${share}%)` : ""
      }`
    );
    lines.push(`• ${title}: ${parts.join(" · ")}`);
  }
  if (queue) {
    lines.push(`На повтор: ${fmt(queue.retry)} · ещё не брали: ${fmt(queue.remaining)}`);
  }
  return lines;
}

function buildVerdict(stats, opts) {
  const bl = stats.bySource.bricklink || {};
  const dayId = opts.dayId;
  const day = dayAttempts(bl, dayId);
  const catalogTotal = ["SET", "MINIFIG", "GEAR"].reduce(
    (s, t) => s + (Number(opts.catalogByType?.[t]) || 0),
    0
  );
  const left = catalogTotal > 0 ? Math.max(0, catalogTotal - uniqueAnswered(bl)) : null;
  const daysLeft = daysLeftInMonth(dayId);
  const need = left != null ? Math.ceil(left / daysLeft) : null;
  const dayAnswers = day.gotPrice + day.empty;

  let pace;
  if (!day.requested) pace = "⚪ за день парсер не работал";
  else if (need == null) pace = "⚪ темп не посчитать";
  else if (dayAnswers >= need) pace = "🟢 успеваем закрыть месяц";
  else if (dayAnswers >= need * 0.6) pace = "🟡 на грани";
  else pace = "🔴 не успеваем закрыть месяц";

  const softShare = pct(day.softBlocked, day.requested);
  let block = "🟢 сайт не режет";
  if (softShare != null && softShare >= 30) block = `🔴 сайт сильно режет (${softShare}% запросов)`;
  else if (softShare != null && softShare >= 10) block = `🟡 сайт иногда режет (${softShare}% запросов)`;

  const lines = ["", `Вывод: ${pace}`];
  if (left != null) {
    lines.push(
      `• без ответа ${SOURCE_TITLES[MAIN_SOURCE]}: ${fmt(left)} · дней до конца месяца: ${daysLeft} · нужно ~${fmt(need)}/день`
    );
  }
  lines.push(`• ответов за день: ${fmt(dayAnswers)}`);
  if (day.requested) lines.push(block);
  return lines;
}

function buildDailyReportText(stats, opts = {}) {
  const dayId = opts.dayId || reportDayId();
  const monthNom = periodIdRu(stats.periodId, "nominative");
  const o = { ...opts, dayId };
  const queues = opts.queues || {};
  const lines = [
    `📊 Парсер цен · отчёт за ${dayIdRu(dayId)}`,
    `(Ереван · ${monthNom})`,
    "",
    "За день",
    formatDayLine("bricklink", dayAttempts(stats.bySource.bricklink, dayId)),
    formatDayLine("brickowl", dayAttempts(stats.bySource.brickowl, dayId)),
    "",
    ...formatMonthBlock("bricklink", stats.bySource.bricklink, opts.catalogByType, queues.bricklink),
    "",
    ...formatMonthBlock("brickowl", stats.bySource.brickowl, opts.catalogByType, queues.brickowl),
    ...buildVerdict(stats, o),
  ];
  if (opts.runUrl) lines.push("", `Лог: ${opts.runUrl}`);
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

async function countSafe(query) {
  try {
    return Number((await query.count().get()).data().count) || 0;
  } catch (e) {
    console.warn("count failed:", e && e.message ? e.message : e);
    return null;
  }
}

async function readCatalogByType(db) {
  const out = {};
  for (const [type] of REPORT_TYPES) {
    if (type === "OTHER") continue;
    out[type] = await countSafe(db.collection("catalog_items").where("itemType", "==", type));
  }
  return out;
}

async function readQueueState(db, periodId, source) {
  let remaining = null;
  try {
    const meta = await readMonthQueueMeta(db, periodId, source);
    if (meta && Number.isFinite(Number(meta.remaining))) remaining = Number(meta.remaining);
  } catch (e) {
    console.warn("queue meta read failed:", e && e.message ? e.message : e);
  }
  const retry = await countSafe(queueRef(db, periodId, source).collection("errors"));
  return { remaining, retry };
}

async function main() {
  const { db } = initFirebaseAdmin();
  const now = new Date();
  const dayId = reportDayId(now);
  const periodId = utcYearMonth(new Date(`${dayId}T12:00:00Z`));
  const stats = await readParserStats(db, periodId);
  const [catalogByType, blQueue, owlQueue] = await Promise.all([
    readCatalogByType(db),
    readQueueState(db, periodId, "bricklink"),
    readQueueState(db, periodId, "brickowl"),
  ]);
  const text = buildDailyReportText(stats, {
    dayId,
    catalogByType,
    queues: { bricklink: blQueue, brickowl: owlQueue },
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
  if (process.env.REPORT_NO_SEND === "1") return;
  const tg = await sendTelegram(text);
  if (!tg.ok && tg.reason === "no_telegram_secrets") process.exitCode = 0;
  else if (!tg.ok) process.exitCode = 1;
}

module.exports = {
  buildDailyReportText,
  formatMonthBlock,
  buildVerdict,
  reportDayId,
  daysLeftInMonth,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
