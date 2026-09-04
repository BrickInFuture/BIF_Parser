/**
 * Итог месяца (после дня 26 UTC, когда автосбор останавливается).
 *
 *   node collector/notifyMonthEndReport.js
 */
"use strict";

const fs = require("fs");
const { readIngestArtifact } = require("./ingestReportArtifacts");
const {
  formatReportDateRu,
  periodIdRu,
  coverageCircles,
  COVERAGE_PCT_TARGET,
  SUCCESS_PCT_TARGET,
} = require("./notifyIngestReport");

function n(v) {
  if (v == null || v === "") return "—";
  return String(v);
}

function buildMonthEndText(kpi = {}, env = process.env) {
  const when = formatReportDateRu(new Date());
  const monthNom = periodIdRu(kpi.periodId, "nominative");
  const periodGen = periodIdRu(kpi.periodId, "genitive");
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
  const mark = coverageCircles(monthPct);
  const trips = Number(kpi.runOkWithPrices != null ? kpi.runOkWithPrices : kpi.runOk);
  const perDay = Number(kpi.okPerDayWithPrices);
  const dayTarget = Number(kpi.okPerDayTarget != null ? kpi.okPerDayTarget : 2000);
  const successPct = kpi.runSuccessPct;
  const runOk = Number(kpi.runOk) || 0;
  const runFail = Number(kpi.runFail) || 0;
  const backlog = kpi.errorBacklogPrimary;
  const target = Number(kpi.targetCoveragePct != null ? kpi.targetCoveragePct : COVERAGE_PCT_TARGET);
  const hitTarget = monthPct != null && monthPct >= target;

  const lines = [
    `📊 Итог ${periodGen}`,
    when,
    "(автосбор дней 1–26 закончен)",
    "",
    `Каталог (наборы + минифиги) ${mark}`,
    "",
    "Наборов со свежими ценами",
    `• с любой ценой в базе: ${n(anyOk)} из ${n(catalog)}${
      anyPct != null ? ` (${anyPct}%)` : ""
    }`,
    `• с ценой текущего месяца (${monthNom}): ${n(monthOk)} из ${n(catalog)}${
      monthPct != null ? ` (${monthPct}%)` : ""
    } — цель ≥${target}%`,
    `• со свежей ценой: ${n(freshOk)} из ${n(catalog)}${
      freshPct != null ? ` (${freshPct}%)` : ""
    }`,
    `• цель ≥${target}% за ${monthNom}: ${hitTarget ? "достигнута" : "не достигнута"}`,
  ];

  if (Number.isFinite(trips) && trips > 0) {
    lines.push(`• успешных съёмов за ${monthNom}: ${trips}`);
    lines.push("  (число удачных походов за ценой за месяц)");
  }
  if (Number.isFinite(perDay) && perDay > 0) {
    lines.push(`• в среднем в день: ${perDay} (цель >${dayTarget})`);
  }
  if (successPct != null && successPct !== "") {
    lines.push(
      `• удачность запросов: ${successPct}% (ок ${runOk}, мимо ${runFail}; цель >${SUCCESS_PCT_TARGET}%)`
    );
  }
  if (backlog != null && backlog !== "") {
    lines.push(`• осталось в очереди ошибок: ${n(backlog)}`);
  }

  lines.push("", "С 1-го числа следующего месяца автосбор снова каждый день.");

  const runUrl = env.GITHUB_RUN_URL || "";
  if (runUrl) lines.push("", `Лог: ${runUrl}`);
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
  const kpi = readIngestArtifact("kpi") || {};
  const text = buildMonthEndText(kpi);
  console.log("\n--- month-end notify preview ---\n" + text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Итог месяца\n\`\`\`\n${text}\n\`\`\`\n`,
      "utf8"
    );
  }
  await sendTelegram(text);
}

module.exports = {
  buildMonthEndText,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(0);
  });
}
