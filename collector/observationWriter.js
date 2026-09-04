/**
 * Единая граница записи для ingest-скриптов (публично-безопасная).
 *
 * Всегда пишет СЫРЬЁ (writeRawObservation.js). Затем оценку BIF:
 *   • BL_RAW_ONLY=1 (публичный прогон) — НЕ считает inline; BIF посчитает
 *     закрытый Firestore-триггер onMarketMonthlyWritten;
 *   • иначе (приватный/локальный) — считает сразу через закрытый модуль
 *     functions/bifFromObservation.js (recomputeBifForItem).
 *
 * Секретный модуль подгружается ЛЕНИВО и только в не-raw режиме, поэтому в
 * публичном репозитории (BL_RAW_ONLY=1) файла functions/bifFromObservation.js
 * может не быть — он не потребуется.
 *
 * Сигнатуры совместимы с прежним writeObservation.js, чтобы не менять
 * ingest-скрипты по существу (только импорт).
 */
"use strict";

const {
  writeRawObservationFromParse,
  writeRawBootstrapMarker,
} = require("./writeRawObservation");

/** Публичный режим «только сырьё» — BIF считает триггер. */
function rawOnly() {
  return process.env.BL_RAW_ONLY === "1";
}

let _bifCore = null;
/** Ленивая загрузка закрытого BIF-модуля (только в не-raw режиме). */
function bifCore() {
  if (_bifCore) return _bifCore;
  // eslint-disable-next-line global-require
  _bifCore = require("./_privateDisabled");
  return _bifCore;
}

/**
 * Запись наблюдения из результата скрейпа (+ BIF, если не raw-only).
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} adminFirestore admin.firestore (для FieldValue)
 * @param {object} payload { catalogItemId, itemType?, setNo?, parsed, method?, errorTag? }
 * @param {{ writeBif?: boolean, dryRun?: boolean }} [opts]
 */
async function writeObservationFromParse(db, adminFirestore, payload, opts = {}) {
  const raw = await writeRawObservationFromParse(db, adminFirestore, payload, opts);

  const wantBif = opts.writeBif !== false && !rawOnly();
  if (opts.dryRun || !wantBif || !raw.wroteObservation) {
    return { ...raw, wroteBif: false };
  }

  try {
    const bif = await bifCore().recomputeBifForItem(
      db,
      adminFirestore.FieldValue,
      String(payload.catalogItemId),
      {}
    );
    return { ...raw, ...bif };
  } catch (e) {
    console.warn("bif recompute skipped:", e && e.message ? e.message : e);
    return { ...raw, wroteBif: false, bifError: String(e && e.message ? e.message : e) };
  }
}

/**
 * Новинка без вторички → сырой bootstrap-маркер (+ BIF RRP×0.9, если не raw-only).
 * @param {object} payload { catalogItemId, itemType?, setNo?, rrpUsd, launchDateMs? }
 */
async function writeRrpBootstrapObservation(db, adminFirestore, payload, opts = {}) {
  const raw = await writeRawBootstrapMarker(db, adminFirestore, payload, opts);
  if (!raw.wrote || opts.dryRun || rawOnly()) {
    return raw;
  }

  try {
    const bif = await bifCore().recomputeBifForItem(
      db,
      adminFirestore.FieldValue,
      String(payload.catalogItemId),
      {}
    );
    return { ...raw, ...bif, bifTypicalNew: bif.bifTypicalNew };
  } catch (e) {
    console.warn("bif bootstrap recompute skipped:", e && e.message ? e.message : e);
    return { ...raw, bifError: String(e && e.message ? e.message : e) };
  }
}

module.exports = {
  rawOnly,
  writeObservationFromParse,
  writeRrpBootstrapObservation,
};
