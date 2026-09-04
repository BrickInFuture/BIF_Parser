/**
 * Price-ingest type phases.
 *
 * Primary (always first): SET + MINIFIG
 * Secondary (only after primary is exhausted for the month, and days remain):
 *   BOX, INSTRUCTION, GEAR
 */
"use strict";

const PRIMARY_TYPES = ["SET", "MINIFIG"];
const SECONDARY_TYPES = ["BOX", "INSTRUCTION", "GEAR"];

/** Cron / monthly ingest stops after day 28 Moscow — leave a buffer before that. */
const SECONDARY_LAST_DAY = 27;

function parseTypesCsv(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const list = String(raw)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}

function moscowDayOfMonth(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
  });
  return Number(fmt.format(d));
}

/**
 * @param {{ phase?: string, typesCsv?: string|null, primaryExhausted?: boolean, dayOfMonth?: number }} opts
 * @returns {{ phase: string, types: string[], allowSecondary: boolean, reason: string }}
 */
function resolveIngestTypes(opts = {}) {
  const override = parseTypesCsv(opts.typesCsv);
  if (override) {
    return {
      phase: "custom",
      types: override,
      allowSecondary: false,
      reason: "types_flag",
    };
  }

  const phaseRaw = String(opts.phase || "auto").toLowerCase();
  const day = Number.isFinite(opts.dayOfMonth) ? opts.dayOfMonth : moscowDayOfMonth();
  const primaryExhausted = opts.primaryExhausted === true;
  const timeLeft = day <= SECONDARY_LAST_DAY;

  if (phaseRaw === "secondary") {
    return {
      phase: "secondary",
      types: [...SECONDARY_TYPES],
      allowSecondary: true,
      reason: "phase_secondary",
    };
  }

  if (phaseRaw === "primary") {
    return {
      phase: "primary",
      types: [...PRIMARY_TYPES],
      allowSecondary: false,
      reason: "phase_primary",
    };
  }

  // auto: primary until exhausted; then secondary only if month still has room
  if (primaryExhausted && timeLeft) {
    return {
      phase: "secondary",
      types: [...SECONDARY_TYPES],
      allowSecondary: true,
      reason: "auto_primary_done_time_left",
    };
  }

  return {
    phase: "primary",
    types: [...PRIMARY_TYPES],
    allowSecondary: false,
    reason: primaryExhausted ? "auto_primary_done_no_time" : "auto_primary",
  };
}

function isPrimaryType(itemType) {
  return PRIMARY_TYPES.includes(String(itemType || "").toUpperCase());
}

function isSecondaryType(itemType) {
  return SECONDARY_TYPES.includes(String(itemType || "").toUpperCase());
}

module.exports = {
  PRIMARY_TYPES,
  SECONDARY_TYPES,
  SECONDARY_LAST_DAY,
  parseTypesCsv,
  moscowDayOfMonth,
  resolveIngestTypes,
  isPrimaryType,
  isSecondaryType,
};
