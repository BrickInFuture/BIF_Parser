/**
 * Отчёт по прогону парсера → Telegram (и опционально email через FormSubmit).
 *
 * Secrets (GitHub Actions):
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  — основной канал
 *   INGEST_NOTIFY_EMAIL (optional)         — копия на почту через FormSubmit
 *
 *   node scripts/bricklink-parser/notifyIngestReport.js
 *
 * Как отличить запуск:
 *   GITHUB_EVENT_NAME=schedule              → по расписанию
 *   BL_RUN_REASON=schedule                  → автопинк (Firebase / запасной kick)
 *   BL_RUN_REASON=owner (или пусто + dispatch) → вручную (ты / агент / кнопка)
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

/**
 * Коротко: по расписанию | вручную.
 * Автопинк Firebase шлёт workflow_dispatch с reason=schedule — иначе GitHub врёт «ручной».
 */
function runKindRu(event, reason) {
  const ev = String(event || "").trim();
  const r = String(reason || "")
    .trim()
    .toLowerCase();
  if (ev === "schedule") return "по расписанию";
  if (r === "schedule" || r === "cron" || r === "auto" || r === "kick") {
    return "по расписанию";
  }
  if (r === "owner" || r === "manual" || r === "agent" || r === "cursor") {
    return "вручную";
  }
  if (ev === "workflow_dispatch") return "вручную";
  return ev || "—";
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
  if (t === "soft_blocked") return "сайт режет частоту";
  if (t === "parse_error") return "страница не разобралась";
  if (t === "partial_prices") return "цены частично";
  if (t === "timeout") return "таймаут";
  if (t === "waf_blocked") return "сайт жёстко закрыл доступ";
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
    (Number(catalog.circuitTrips) > 0 &&
      conclusion === "success" &&
      chunkDone > 0 &&
      chunkDone < 60);
  const trips = Number(catalog.circuitTrips) || 0;
  // Только метки ЭТОГО залпа — не месячные накопления.
  const windowTags = catalog.chunkErrorTagCounts || {};
  const tags = topErrorTags(windowTags);
  const soft = Number(windowTags.soft_blocked) || 0;
  const parseErr = Number(windowTags.parse_error) || 0;
  const gapPaused = catalog.gapPausedAfterHot === true;
  const scrapeSec = Number(catalog.scrapeElapsedSec) || 0;

  if (conclusion === "cancelled") {
    if (!chunkDone) {
      lines.push("Прогон оборвали до сводки — цифр этого окна нет.");
    } else {
      lines.push(`Прогон оборвали после ${chunkDone} запросов (успели ${chunkOk} с ценами).`);
    }
  } else if (conclusion === "failure") {
    lines.push("Прогон упал с ошибкой — смотри лог по ссылке.");
  } else if (timedOut) {
    lines.push("Время окна кончилось — не все запросы успели.");
  } else if (trips > 0 && (catalog.circuitOpen || circuitStop)) {
    lines.push(
      `Остановились: сайт начал резать частоту (${trips} ${
        trips === 1 ? "волна" : trips < 5 ? "волны" : "волн"
      }). Лучше подождать следующий залп.`
    );
  } else if (chunkPct != null && Number(chunkPct) >= SUCCESS_PCT_TARGET) {
    lines.push("Залп прошёл нормально — почти все запросы дали цены.");
  } else if (chunkPct != null && Number(chunkPct) < SUCCESS_PCT_TARGET) {
    lines.push("Много пустых или битых ответов — сайт резал или страницы пришли кривые.");
  } else if (!chunkDone) {
    lines.push("В этом прогоне каталог почти ничего не записал.");
  }

  if (soft > 0) lines.push(`Сайт резал частоту: ${soft} раз.`);
  if (parseErr > 0) lines.push(`Страница не разобралась: ${parseErr}.`);
  if (gapPaused) {
    lines.push("После жары шли только дальше по каталогу, без очереди дыр.");
  }
  if (scrapeSec > 0 && chunkOk > 0 && scrapeSec / chunkOk > 30) {
    lines.push("На одну цену ушло много времени — съели паузы и отказы.");
  }
  // Повтор ошибок — отдельной строкой в отчёте, здесь не дублируем.
  if (tags.length && conclusion !== "cancelled") {
    const onlySoftParse =
      tags.every(([k]) => k === "soft_blocked" || k === "parse_error") &&
      soft + parseErr > 0;
    if (!onlySoftParse) {
      const top = tags.map(([k, v]) => `${tagRu(k)} ×${v}`).join("; ");
      lines.push(`Чаще всего: ${top}.`);
    }
  }

  if (!lines.length) lines.push("По сводке заметных проблем нет.");
  return lines;
}

function buildCoverageLines(kpi, chunkOk, pricedPct, coverMark) {
  const lines = [];
  const fresh = Number(kpi.freshOkPrimary);
  const catalog = Number(kpi.catalogPrimary);
  const monthPriced = Number(
    kpi.runOkWithPrices != null ? kpi.runOkWithPrices : kpi.runOk
  );
  const perDay = Number(kpi.okPerDayWithPrices);
  const dayTarget = Number(kpi.okPerDayTarget != null ? kpi.okPerDayTarget : 2000);
  const successPct = kpi.runSuccessPct;
  const runOk = Number(kpi.runOk) || 0;
  const runFail = Number(kpi.runFail) || 0;
  const backlog = kpi.errorBacklogPrimary;

  lines.push(
    `Каталог ${coverMark} — свежие цены (за ~28 дней, цель ≥${COVERAGE_PCT_TARGET}%):`
  );
  if (Number.isFinite(fresh) && Number.isFinite(catalog) && catalog > 0) {
    lines.push(
      `• сейчас с ценой: ${fresh} из ${catalog}${
        pricedPct != null ? ` (${pricedPct}%)` : ""
      }`
    );
  } else {
    lines.push(`• сейчас с ценой: ${n(kpi.freshOkPrimary)} из ${n(kpi.catalogPrimary)}`);
  }

  if (Number.isFinite(monthPriced) && monthPriced > 0) {
    lines.push(`• съёмов с ценой за месяц: ${monthPriced}`);
  }
  if (Number.isFinite(perDay) && perDay > 0) {
    const pace =
      perDay >= dayTarget
        ? "темп ок"
        : perDay >= dayTarget * 0.75
          ? "темп ниже цели"
          : "темпа не хватает — покрытие почти не растёт";
    lines.push(`• в среднем в день: ${perDay} (цель >${dayTarget}) — ${pace}`);
  } else {
    lines.push(`• в среднем в день: ${n(kpi.okPerDayWithPrices)} (цель >${dayTarget})`);
  }

  if (successPct != null && successPct !== "") {
    lines.push(
      `• удачность за месяц: ${successPct}% (ок ${runOk}, мимо ${runFail}; цель >${SUCCESS_PCT_TARGET}%)`
    );
  }
  if (backlog != null && backlog !== "") {
    lines.push(`• ждут повтора после ошибки: ${n(backlog)}`);
  }

  if (pricedPct != null && pricedPct < 50) {
    lines.push("• 🚨 меньше половины каталога со свежей ценой — критично");
  }

  if (
    chunkOk >= 30 &&
    Number.isFinite(perDay) &&
    perDay < dayTarget * 0.75 &&
    pricedPct != null &&
    pricedPct < 90
  ) {
    lines.push(
      "• часть цен устаревает (выпадает из окна ~28 дней), а залпы пока не успевают наращивать уникальных"
    );
  }

  return lines;
}

function buildReportText(env = process.env) {
  const catalog = readIngestArtifact("catalog") || {};
  const retry = readIngestArtifact("retry") || {};
  const kpi = readIngestArtifact("kpi") || {};
  const conclusion = env.JOB_CONCLUSION || "unknown";
  const runUrl = env.GITHUB_RUN_URL || "";
  const event = env.GITHUB_EVENT_NAME || "";
  const reason = env.BL_RUN_REASON || "";

  const chunkDone = Number(catalog.chunkDone) || 0;
  const chunkOk = Number(catalog.chunkOkWithPrices) || 0;
  const chunkNoData = Number(catalog.chunkNoData) || 0;
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

  const circle = statusCircle(conclusion, chunkPct);
  const pricedPct =
    kpi.pricedPctPrimary != null && Number.isFinite(Number(kpi.pricedPctPrimary))
      ? Number(kpi.pricedPctPrimary)
      : null;
  const coverMark = coverageCircles(pricedPct);
  const when = formatReportDateRu(new Date());
  const kind = runKindRu(event, reason);
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
    kind,
    "",
    "Этот залп:",
    `• запросов: ${n(catalog.chunkDone)}`,
    `• с ценами: ${n(catalog.chunkOkWithPrices)}${
      chunkPct != null ? ` (${chunkPct}%, цель >${SUCCESS_PCT_TARGET}%)` : ""
    }`,
  ];
  if (chunkNoData > 0) {
    lines.push(`• без данных на сайте: ${chunkNoData}`);
  }
  if (secPerOk != null) {
    lines.push(`• скорость: ~${formatSecPerOk(secPerOk)} на одну цену`);
  }

  const retryAttempted = Number(retry.attempted) || 0;
  if (retryAttempted > 0) {
    lines.push(
      "",
      `Повтор старых ошибок: ${n(retry.chunkOk)} ок / ${n(retry.chunkFail)} мимо (из ${retryAttempted})`
    );
  }

  lines.push("", "Что произошло:", ...analysis.map((s) => `• ${s}`));
  lines.push("", ...buildCoverageLines(kpi, chunkOk, pricedPct, coverMark));

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
  buildCoverageLines,
  formatSecPerOk,
  runKindRu,
  COVERAGE_PCT_TARGET,
  SUCCESS_PCT_TARGET,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(0);
  });
}
