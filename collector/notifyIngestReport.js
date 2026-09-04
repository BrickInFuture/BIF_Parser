/**
 * Отчёт по прогону парсера → Telegram.
 *
 *   node collector/notifyIngestReport.js
 *
 * Запуск: schedule / BL_RUN_REASON=schedule → «по расписанию»;
 *         owner / кнопка → «вручную».
 */
"use strict";

const fs = require("fs");
const { readIngestArtifact } = require("./ingestReportArtifacts");

const REPORT_TZ = process.env.BL_REPORT_TZ || "Asia/Dubai";

const MONTHS_RU_GENITIVE = [
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

const MONTHS_RU_NOMINATIVE = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];

const COVERAGE_PCT_TARGET = 98;
const SUCCESS_PCT_TARGET = 90;

function n(v) {
  if (v == null || v === "") return "—";
  return String(v);
}

function formatSecPerOk(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 90) return `${Math.round(s * 10) / 10} с`;
  return `${Math.round((s / 60) * 10) / 10} мин`;
}

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
  return `${day} ${MONTHS_RU_GENITIVE[month - 1]} ${year}, ${hourStr}:${minute} ${dayPart}`;
}

/** 2026-09 → «сентябрь 2026» / «сентября 2026» / «сентябре 2026» */
function periodIdRu(periodId, form = "nominative") {
  const m = String(periodId || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return periodId || "—";
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return periodId;
  const names = {
    nominative: MONTHS_RU_NOMINATIVE,
    genitive: MONTHS_RU_GENITIVE,
    prepositional: [
      "январе",
      "феврале",
      "марте",
      "апреле",
      "мае",
      "июне",
      "июле",
      "августе",
      "сентябре",
      "октябре",
      "ноябре",
      "декабре",
    ],
  };
  const list = names[form] || MONTHS_RU_NOMINATIVE;
  return `${list[month - 1]} ${year}`;
}

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
    if (!chunkDone) {
      lines.push("Залп не стартовал (сбой до запросов) — цифр этого окна нет.");
    } else {
      lines.push("Прогон упал с ошибкой после части запросов — смотри лог по ссылке.");
    }
  } else if (timedOut) {
    lines.push("Время окна кончилось — не все запросы успели.");
  } else if (trips > 0 && (catalog.circuitOpen || circuitStop)) {
    lines.push(
      `Остановились: сайт начал резать частоту (${trips} ${
        trips === 1 ? "волна" : trips < 5 ? "волны" : "волн"
      }).`
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

/**
 * Блок каталога: любая цена / цена текущего месяца / свежая (~28 дней).
 */
function buildCoverageLines(kpi, chunkOk, opts = {}) {
  const lines = [];
  const monthNom = periodIdRu(kpi.periodId, "nominative");
  const monthOk = Number(kpi.monthOkPrimary);
  const anyOk = Number(kpi.anyOkPrimary);
  const freshOk = Number(kpi.freshOkPrimary);
  const catalog = Number(kpi.catalogPrimary);
  const monthPct =
    kpi.monthPricedPctPrimary != null && Number.isFinite(Number(kpi.monthPricedPctPrimary))
      ? Number(kpi.monthPricedPctPrimary)
      : catalog > 0 && Number.isFinite(monthOk)
        ? Math.round((monthOk / catalog) * 1000) / 10
        : null;
  const anyPct =
    kpi.anyPricedPctPrimary != null && Number.isFinite(Number(kpi.anyPricedPctPrimary))
      ? Number(kpi.anyPricedPctPrimary)
      : catalog > 0 && Number.isFinite(anyOk)
        ? Math.round((anyOk / catalog) * 1000) / 10
        : null;
  const freshPct =
    kpi.pricedPctPrimary != null && Number.isFinite(Number(kpi.pricedPctPrimary))
      ? Number(kpi.pricedPctPrimary)
      : catalog > 0 && Number.isFinite(freshOk)
        ? Math.round((freshOk / catalog) * 1000) / 10
        : null;
  const coverMark = coverageCircles(monthPct);
  const trips = Number(kpi.runOkWithPrices != null ? kpi.runOkWithPrices : kpi.runOk);
  const perDay = Number(kpi.okPerDayWithPrices);
  const dayTarget = Number(kpi.okPerDayTarget != null ? kpi.okPerDayTarget : 2000);
  const successPct = kpi.runSuccessPct;
  const runOk = Number(kpi.runOk) || 0;
  const runFail = Number(kpi.runFail) || 0;
  const backlog = kpi.errorBacklogPrimary;
  const burstDidNotRun = opts.burstDidNotRun === true;

  lines.push(`Каталог (наборы + минифиги) ${coverMark}`);
  if (burstDidNotRun) {
    lines.push("• залп не писал цены — ниже без изменений с прошлого успешного съёма");
  }

  lines.push("", "Наборов со свежими ценами");
  if (Number.isFinite(anyOk) && Number.isFinite(catalog) && catalog > 0) {
    lines.push(
      `• с любой ценой в базе: ${anyOk} из ${catalog}${anyPct != null ? ` (${anyPct}%)` : ""}`
    );
  } else {
    lines.push(`• с любой ценой в базе: ${n(kpi.anyOkPrimary)} из ${n(kpi.catalogPrimary)}`);
  }

  if (Number.isFinite(monthOk) && Number.isFinite(catalog) && catalog > 0) {
    lines.push(
      `• с ценой текущего месяца (${monthNom}): ${monthOk} из ${catalog}${
        monthPct != null ? ` (${monthPct}%)` : ""
      } — цель ≥${COVERAGE_PCT_TARGET}%`
    );
  } else {
    lines.push(
      `• с ценой текущего месяца: ${n(kpi.monthOkPrimary)} из ${n(
        kpi.catalogPrimary
      )} — цель ≥${COVERAGE_PCT_TARGET}%`
    );
  }

  if (Number.isFinite(freshOk) && Number.isFinite(catalog) && catalog > 0) {
    lines.push(
      `• со свежей ценой: ${freshOk} из ${catalog}${freshPct != null ? ` (${freshPct}%)` : ""}`
    );
  } else if (kpi.freshOkPrimary != null) {
    lines.push(`• со свежей ценой: ${n(kpi.freshOkPrimary)} из ${n(kpi.catalogPrimary)}`);
  }

  if (Number.isFinite(trips) && trips > 0) {
    lines.push(`• успешных съёмов за ${monthNom}: ${trips}`);
    lines.push("  (число удачных походов за ценой за месяц)");
  }

  if (Number.isFinite(perDay) && perDay > 0) {
    const pace =
      perDay >= dayTarget
        ? "темп ок"
        : perDay >= dayTarget * 0.75
          ? "темп ниже цели"
          : "темпа не хватает";
    lines.push(`• в среднем в день: ${perDay} (цель >${dayTarget}) — ${pace}`);
  }

  if (successPct != null && successPct !== "") {
    lines.push(
      `• удачность запросов за ${monthNom}: ${successPct}% (ок ${runOk}, мимо ${runFail}; цель >${SUCCESS_PCT_TARGET}%)`
    );
  }
  if (backlog != null && backlog !== "") {
    lines.push(`• ждут повтора после ошибки: ${n(backlog)}`);
  }

  if (monthPct != null && monthPct < 50 && !burstDidNotRun) {
    lines.push(`• 🚨 меньше половины каталога с ценой за ${monthNom} — критично`);
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
    `(${kind})`,
    "",
    "Этот залп:",
    `• запросили цену у ${n(catalog.chunkDone)} позиций`,
    `• цену получили: ${n(catalog.chunkOkWithPrices)}${
      chunkPct != null ? ` (${chunkPct}%, цель >${SUCCESS_PCT_TARGET}%)` : ""
    }`,
  ];
  if (chunkNoData > 0) {
    lines.push(`• на сайте пусто (цены нет): ${chunkNoData}`);
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
  const burstDidNotRun =
    (conclusion === "failure" || conclusion === "cancelled") && chunkDone === 0;
  lines.push("", ...buildCoverageLines(kpi, chunkOk, { burstDidNotRun }));

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
  periodIdRu,
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
