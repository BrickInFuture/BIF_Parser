/**
 * Отчёт по прогону парсера → Telegram (и опционально email через FormSubmit).
 *
 * Secrets (GitHub Actions):
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  — основной канал
 *   INGEST_NOTIFY_EMAIL (optional)         — копия на почту через FormSubmit
 *
 *   node collector/notifyIngestReport.js
 */
"use strict";

const fs = require("fs");
const { readIngestArtifact } = require("./ingestReportArtifacts");

/** Часовой пояс отчёта (владелец в UTC+4). */
const REPORT_TZ = process.env.BL_REPORT_TZ || "Asia/Dubai";

const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function n(v) {
  if (v == null || v === "") return "—";
  return String(v);
}

/** Секунды → коротко по-русски: "19 с" / "3.2 мин". */
function formatSecPerOk(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 90) return `${Math.round(s * 10) / 10} с`;
  return `${Math.round((s / 60) * 10) / 10} мин`;
}

/** "3 сентября 2026, 04:04 утра" */
function formatReportDateRu(date = new Date(), timeZone = REPORT_TZ) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const day = Number(get("day"));
  const month = Number(get("month"));
  const year = Number(get("year"));
  const hour = Number(get("hour"));
  const minute = String(get("minute") || "00").padStart(2, "0");
  const hourStr = String(hour).padStart(2, "0");
  // Как в примере: «04:04 утра» (ночь только 0–3).
  let dayPart = "дня";
  if (hour >= 0 && hour < 4) dayPart = "ночи";
  else if (hour >= 4 && hour < 12) dayPart = "утра";
  else if (hour >= 12 && hour < 17) dayPart = "дня";
  else dayPart = "вечера";
  return `${day} ${MONTHS_RU[month - 1]} ${year}, ${hourStr}:${minute} ${dayPart}`;
}

/** Цель покрытия каталога свежими ценами. */
const COVERAGE_PCT_TARGET = 98;

/** Цель успеха окна / месяца в отчёте. */
const SUCCESS_PCT_TARGET = 90;

/**
 * Шкала покрытия (свежие цены / каталог наборы+минифиги):
 * ≥98 🟢🟢🟢 · ≥95 🟢🟢 · ≥90 🟢 ·
 * ≥85 🟡🟡🟡 · ≥75 🟡🟡 · ≥70 🟡 ·
 * ≥50 🔴 · <50 🚨
 */
function coverageCircles(pricedPct) {
  if (pricedPct == null || !Number.isFinite(Number(pricedPct))) return "—";
  const p = Number(pricedPct);
  if (p >= 98) return "🟢🟢🟢";
  if (p >= 95) return "🟢🟢";
  if (p >= 90) return "🟢";
  if (p >= 85) return "🟡🟡🟡";
  if (p >= 75) return "🟡🟡";
  if (p >= 70) return "🟡";
  if (p >= 50) return "🔴";
  return "🚨";
}

/**
 * 🟢 успех ≥90%, 🟡 ниже, 🔴 отменён / ошибка / нет данных прогона.
 */
function statusCircle(conclusion, chunkPct) {
  if (conclusion === "cancelled" || conclusion === "failure") return "🔴";
  if (chunkPct == null || !Number.isFinite(Number(chunkPct))) return "🟡";
  if (Number(chunkPct) >= SUCCESS_PCT_TARGET) return "🟢";
  return "🟡";
}

function statusRu(conclusion) {
  if (conclusion === "success") return "OK";
  if (conclusion === "failure") return "ОШИБКА";
  if (conclusion === "cancelled") return "отменён";
  return conclusion || "unknown";
}

function eventRu(event) {
  if (event === "schedule") return "по расписанию";
  if (event === "workflow_dispatch") return "ручной запуск";
  return event || "—";
}

function topErrorTags(errorTagCounts, limit = 3) {
  const entries = Object.entries(errorTagCounts || {})
    .map(([k, v]) => [k, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  return entries.slice(0, limit);
}

function tagRu(tag) {
  const t = String(tag || "");
  if (t === "soft_blocked") return "сайт режет (Oops/429)";
  if (t === "parse_error") return "не разобрали HTML";
  if (t === "partial_prices") return "цены частично";
  if (t === "timeout") return "таймаут";
  if (t === "waf_blocked") return "жёсткая защита сайта";
  if (t === "exception") return "сбой запроса";
  return t;
}

/** Короткий разбор: что случилось в этом окне. */
function buildAnalysis({ conclusion, catalog, retry, chunkPct, chunkDone, chunkOk }) {
  const lines = [];
  const timedOut = catalog.timedOut === true;
  const circuitStop =
    catalog.circuitOpenThisWindow === true ||
    catalog.stopRequested === true ||
    (Number(catalog.circuitTrips) > 0 && conclusion === "success" && chunkDone > 0 && chunkDone < 60);
  const trips = Number(catalog.circuitTrips) || 0;
  const tags = topErrorTags(catalog.errorTagCounts);
  const soft = Number(catalog.errorTagCounts?.soft_blocked) || 0;
  const parseErr = Number(catalog.errorTagCounts?.parse_error) || 0;
  const gapPaused = catalog.gapPausedAfterHot === true;
  const scrapeSec = Number(catalog.scrapeElapsedSec) || 0;
  const retryFail = Number(retry.chunkFail) || 0;
  const retryOk = Number(retry.chunkOk) || 0;
  const retryAttempted = Number(retry.attempted) || 0;

  if (conclusion === "cancelled") {
    if (!chunkDone) {
      lines.push("Прогон оборвали до сводки — цифр этого окна нет (отмена / новый запуск поверх).");
    } else {
      lines.push(`Прогон оборвали после ${chunkDone} запросов (${chunkOk} с ценами).`);
    }
  } else if (conclusion === "failure") {
    lines.push("Прогон упал с ошибкой — смотри лог по ссылке.");
  } else if (timedOut) {
    lines.push("Упёрлись в лимит времени окна, не все попытки успели.");
  } else if (trips > 0 && (catalog.circuitOpen || circuitStop)) {
    const waveWord =
      trips === 1 ? "волну" : trips >= 2 && trips <= 4 ? "волны" : "волн";
    lines.push(
      `Окно остановили из‑за жары IP: ${trips} ${waveWord} «сайт режет» (стоп после отказов).`
    );
  } else if (chunkPct != null && Number(chunkPct) >= SUCCESS_PCT_TARGET) {
    lines.push("Залп прошёл нормально: большинство запросов дали цены.");
  } else if (chunkPct != null && Number(chunkPct) < SUCCESS_PCT_TARGET) {
    lines.push(
      `Успех ниже ${SUCCESS_PCT_TARGET}% — сайт часто резал или много пустых/битых страниц.`
    );
  } else if (!chunkDone) {
    lines.push("Каталог в этом прогоне почти ничего не записал — сводки нет.");
  }

  if (soft > 0) {
    lines.push(`Отказов «сайт режет»: ${soft}.`);
  }
  if (parseErr > 0) {
    lines.push(`Ошибок разбора HTML: ${parseErr}.`);
  }
  if (gapPaused) {
    lines.push("После жары очередь дыр отключили — шли только дальше по каталогу.");
  }
  if (scrapeSec > 0 && chunkOk > 0 && scrapeSec / chunkOk > 30) {
    lines.push("Много времени на одну цену — похоже, съели паузы/отказы, не сами запросы.");
  }
  if (retryAttempted > 0) {
    if (retryFail > retryOk) {
      lines.push(`Повтор ошибок слабый: ${retryOk} ок / ${retryFail} снова мимо.`);
    } else if (retryOk > 0) {
      lines.push(`Повтор ошибок подтянул ещё ${retryOk} из ${retryAttempted}.`);
    }
  }
  if (tags.length && conclusion !== "cancelled") {
    const top = tags.map(([k, v]) => `${tagRu(k)} ×${v}`).join("; ");
    lines.push(`Топ меток: ${top}.`);
  }

  if (!lines.length) lines.push("Заметных проблем по сводке не видно.");
  return lines;
}

function buildReportText() {
  const catalog = readIngestArtifact("catalog") || {};
  const retry = readIngestArtifact("retry") || {};
  const kpi = readIngestArtifact("kpi") || {};
  const conclusion = process.env.JOB_CONCLUSION || "unknown";
  const runUrl = process.env.GITHUB_RUN_URL || "";
  const event = process.env.GITHUB_EVENT_NAME || "";

  const chunkDone = Number(catalog.chunkDone) || 0;
  const chunkOk = Number(catalog.chunkOkWithPrices) || 0;
  const chunkPct =
    catalog.chunkSuccessPct != null
      ? Number(catalog.chunkSuccessPct)
      : chunkDone > 0
        ? Math.round((chunkOk / chunkDone) * 1000) / 10
        : null;
  const secPerOk =
    catalog.secPerOkWithPrices != null
      ? catalog.secPerOkWithPrices
      : chunkOk > 0 && catalog.scrapeElapsedSec
        ? Math.round((Number(catalog.scrapeElapsedSec) / chunkOk) * 10) / 10
        : null;
  const okPerHour =
    catalog.okPerHour != null
      ? catalog.okPerHour
      : secPerOk > 0
        ? Math.round((3600 / secPerOk) * 10) / 10
        : null;

  const circle = statusCircle(conclusion, chunkPct);
  const pricedPct =
    kpi.pricedPctPrimary != null && Number.isFinite(Number(kpi.pricedPctPrimary))
      ? Number(kpi.pricedPctPrimary)
      : null;
  const coverMark = coverageCircles(pricedPct);
  const when = formatReportDateRu(new Date());
  const analysis = buildAnalysis({
    conclusion,
    catalog,
    retry,
    chunkPct,
    chunkDone,
    chunkOk,
  });

  const lines = [
    `${circle} Парсер цен — ${statusRu(conclusion)}`,
    when,
    `Месяц: ${n(kpi.periodId || catalog.periodId)} · ${eventRu(event)}`,
    "",
    "Каталог (этот прогон):",
    `• запросов: ${n(catalog.chunkDone)}`,
    `• с ценами: ${n(catalog.chunkOkWithPrices)}`,
    `• без данных: ${n(catalog.chunkNoData)}`,
    `• успех: ${chunkPct != null ? `${chunkPct}%` : "—"} (цель >${SUCCESS_PCT_TARGET}%)`,
    `• на 1 цену: ${formatSecPerOk(secPerOk)}${okPerHour != null ? ` (~${n(okPerHour)} цен/час)` : ""}`,
    "",
    "Повтор ошибок:",
    `• попыток: ${n(retry.attempted)} · OK ${n(retry.chunkOk)} · fail ${n(retry.chunkFail)}`,
    "",
    "Что произошло:",
    ...analysis.map((s) => `• ${s}`),
    "",
    `Покрытие ${coverMark} (наборы+минифиги, цель ≥${COVERAGE_PCT_TARGET}%):`,
    `• с ценами: ${n(kpi.freshOkPrimary)} из ${n(kpi.catalogPrimary)} (${pricedPct != null ? `${pricedPct}%` : "—"})`,
    `• в день: ${n(kpi.okPerDayWithPrices)} (цель >${n(kpi.okPerDayTarget != null ? kpi.okPerDayTarget : 2000)})`,
    `• успех за месяц: ${n(kpi.runSuccessPct)}% (цель >${SUCCESS_PCT_TARGET}%; ok ${n(kpi.runOk)} / fail ${n(kpi.runFail)})`,
    `• очередь ошибок: ${n(kpi.errorBacklogPrimary)}`,
  ];
  if (pricedPct != null && pricedPct < 50) {
    lines.push("• 🚨 покрытие ниже 50% — критично, каталог почти без свежих цен");
  }
  if (runUrl) {
    lines.push("", `Лог: ${runUrl}`);
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

async function sendEmailCopy(text) {
  const to = String(process.env.INGEST_NOTIFY_EMAIL || "").trim();
  if (!to) {
    console.log("Email: INGEST_NOTIFY_EMAIL not set — skip");
    return { ok: false, reason: "no_email" };
  }
  const subject = `Парсер цен: ${process.env.JOB_CONCLUSION || "report"}`;
  const form = new URLSearchParams();
  form.set("email", to);
  form.set("_subject", subject);
  form.set("message", text);
  try {
    const res = await fetch("https://formsubmit.co/ajax/" + encodeURIComponent(to), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      console.warn("Email FormSubmit failed:", res.status, await res.text().catch(() => ""));
      return { ok: false, reason: "formsubmit_http", status: res.status };
    }
    console.log("Email: sent via FormSubmit to", to);
    return { ok: true };
  } catch (e) {
    console.warn("Email send error:", e.message);
    return { ok: false, reason: e.message };
  }
}

async function main() {
  const text = buildReportText();
  console.log("\n--- ingest notify preview ---\n" + text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Отчёт (уведомление)\n\`\`\`\n${text}\n\`\`\`\n`,
      "utf8"
    );
  }
  const tg = await sendTelegram(text);
  const mail = await sendEmailCopy(text);
  if (!tg.ok && !mail.ok) {
    console.log(
      "No notify channel configured. Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (recommended)."
    );
  }
}

module.exports = {
  buildReportText,
  formatReportDateRu,
  statusCircle,
  coverageCircles,
  buildAnalysis,
  formatSecPerOk,
  COVERAGE_PCT_TARGET,
  SUCCESS_PCT_TARGET,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(0);
  });
}
