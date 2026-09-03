/**
 * Несекретные утилиты каталога для «сырого» пути парсера (публичный репозиторий).
 *
 * Здесь ТОЛЬКО выбор полей и сборка id — никаких формул оценки BIF.
 * Формула оценки BIF живёт в закрытой части (functions/) и в публичный
 * путь парсера не попадает.
 *
 * Реализации пикеров (id набора, выбор RRP/даты выхода) — простой каталожный
 * код без формул. effectiveBrickLinkLookup (маппинг CMF → BrickLink) тоже
 * несекретный; в основном репозитории он берётся из закрытой папки, а скрипт
 * экспорта (parser:export-public) заменяет этот require на локальный
 * ./cmfCatalog и кладёт cmfCatalog.js рядом — публичная папка самодостаточна.
 */
"use strict";

const { effectiveBrickLinkLookup } = require("./cmfCatalog");

const DEFAULT_SOURCE = "bricklink";

/** Ключ документа наблюдения: `{catalogItemId}__{source}` (напр. SET_75192-1__bricklink). */
function observationDocId(catalogItemId, source = DEFAULT_SOURCE) {
  return `${catalogItemId}__${source}`;
}

/**
 * Положительный USD или null — отсутствие / 0 / мусор → null, чтобы аналитика их пропускала.
 * @param {*} raw
 * @returns {number|null}
 */
function positiveUsdOrNull(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** US RRP из полей catalog_items (rrpUsd / устаревшее USRetailPrice). */
function pickCatalogRrpUsd(catalogItem = {}) {
  return (
    positiveUsdOrNull(catalogItem?.rrpUsd) ??
    positiveUsdOrNull(catalogItem?.USRetailPrice) ??
    null
  );
}

/** Дата выхода набора в мс (launchDateMs / launchDate DD/MM/YYYY / yearReleased). */
function pickCatalogLaunchMs(catalogItem = {}) {
  const msRaw = Number(catalogItem?.launchDateMs ?? catalogItem?.launchMs);
  if (Number.isFinite(msRaw) && msRaw > 0) return msRaw;

  const launchDate = catalogItem?.launchDate;
  if (launchDate != null && launchDate !== "") {
    const s = String(launchDate).trim();
    const dmY = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (dmY) return Date.UTC(Number(dmY[3]), Number(dmY[2]) - 1, Number(dmY[1]));
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const year = Number(catalogItem?.yearReleased ?? catalogItem?.year);
  if (Number.isFinite(year) && year >= 1949 && year <= 2100) {
    return Date.UTC(year, 0, 1);
  }
  return null;
}

module.exports = {
  DEFAULT_SOURCE,
  observationDocId,
  positiveUsdOrNull,
  pickCatalogRrpUsd,
  pickCatalogLaunchMs,
  effectiveBrickLinkLookup,
};
