/**
 * Отчёт по прогону BrickLink → Telegram (и опционально email через FormSubmit).
 *
 * Secrets (GitHub Actions):
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  — основной канал
 *   INGEST_NOTIFY_EMAIL (optional)         — копия на почту через FormSubmit
 *
 *   node scripts/bricklink-parser/notifyIngestReport.js
 */
"use strict";

const fs = require("fs");
const { readIngestArtifact } = require("./ingestReportArtifacts");

function n(v) {
  if (v == null || v === "") return "—";
  return String(v);
}

function buildReportText() {
  const catalog = readIngestArtifact("catalog") || {};
  const retry = readIngestArtifact("retry") || {};
  const kpi = readIngestArtifact("kpi") || {};
  const conclusion = process.env.JOB_CONCLUSION || "unknown";
  const runUrl = process.env.GITHUB_RUN_URL || "";
  const event = process.env.GITHUB_EVENT_NAME || "";
  const statusRu =
    conclusion === "success"
      ? "OK"
      : conclusion === "failure"
        ? "ОШИБКА"
        : conclusion === "cancelled"
          ? "отменён"
          : conclusion;

  const lines = [
    `BrickLink парсер — прогон ${statusRu}`,
    `Месяц: ${n(kpi.periodId || catalog.periodId)} · событие: ${n(event)}`,
    "",
    "Каталог (этот прогон):",
    `• запросов: ${n(catalog.chunkDone)}`,
    `• с ценами: ${n(catalog.chunkOkWithPrices)}`,
    `• без данных: ${n(catalog.chunkNoData)}`,
    `• успех: ${n(catalog.successPct)}%`,
    "",
    "Повтор ошибок:",
    `• попыток: ${n(retry.attempted)} · OK ${n(retry.chunkOk)} · fail ${n(retry.chunkFail)}`,
    "",
    "Покрытие (наборы+минифиги):",
    `• с ценами: ${n(kpi.freshOkPrimary)} из ${n(kpi.catalogPrimary)} (${n(kpi.pricedPctPrimary)}%)`,
    `• в день: ${n(kpi.okPerDayWithPrices)} (цель ≥${n(kpi.okPerDayTarget)})`,
    `• успех за месяц: ${n(kpi.runSuccessPct)}% (ok ${n(kpi.runOk)} / fail ${n(kpi.runFail)})`,
    `• очередь ошибок: ${n(kpi.errorBacklogPrimary)}`,
  ];
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
  const subject = `BrickLink парсер: ${process.env.JOB_CONCLUSION || "report"}`;
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

main().catch((e) => {
  console.error(e);
  process.exit(0);
});
