# Правила парсинга цен (BrickLink)

Канон для bulk ingest, GHA и локальных догонов. Код: `coveragePolicy.js`, `ingestCatalog.js`, `writeRawObservation.js` + `observationWriter.js` (BIF — закрыто: `functions/bifFromObservation.js`).

**Источник сейчас:** BrickLink HTML Price Guide — сводка + **все** помесячные sold-блоки на странице (не только последние 6 месяцев). Если сводка есть, а помесячных заголовков нет — всё равно **ok** (пишем сводку).  
Публично в UI — только **BIF** (не сырые avg гида).

---

## Кому когда скрейпить

| Когорт | Условие | Частота |
|--------|---------|---------|
| **Слишком рано** | есть launch, возраст **&lt; 2 суток** | **не трогать** (вторичка ещё пустая) |
| **Новинка** | launch **+2 дня … +365 дней** | **1 точка на календарный месяц** (ok или bootstrap) |
| **Зрелый** | возраст ≥ 1 год **или** нет launch | только если нет рыночного **ok** старше **~6 месяцев** (180 суток) |

Типы в GHA-окне: **только SET + MINIFIG**.  
BOX / INSTRUCTION / GEAR — **локально руками** после 26-го или `--phase=secondary`. Не цель «100 тыс. попыток».

Порядок в батче: **сначала новинки и популярные темы** (`catalogPriority.js`), затем SET ↔ MINIFIG по курсору. В конце слота — короткий `retry-errors` (не свежий Oops).

---

## Нет рынка у новинки

После успешного скрейпа с пустым PG → записать BIF **`RRP × 0.9`**, метод / tag **`rrp_bootstrap_0_9`**.  
Это не sold. На следующий месяц снова пробуем живой гид.

---

## Календарь исполнения

| Дни месяца | Канал | Что |
|------------|--------|-----|
| **1–26** | **публичный** `BIF_Parser` по cron | primary SET+MINIFIG, HTTP token, limit 1200, 80 мин |
| **27–конец** | **Локально руками** (при необходимости) | добить дыры / secondary |
| **всегда** | Pro refresh (кнопка на сайте) | полный скрейп; очередь в привате — **только dispatch** |

**Доставка:** Playwright один раз → WAF-токен → дальше HTTP fetch (`http_token_catalogPG`).

Минуты GitHub на публичном репо **безлимитные**. Закрытый репо **не** гоняет bulk по расписанию.

### Ручной пинок (публичный)

```bash
gh workflow run "BrickLink parser (public, raw-only)" --repo BrickInFuture/BIF_Parser
gh run list --repo BrickInFuture/BIF_Parser --limit 5
```

Нужен секрет `FIREBASE_SERVICE_ACCOUNT_DEV` в **BIF_Parser**. Proxy опционален.

### Параметры GHA (публичный, сентябрь 2026)

- Расписание: **3×/сутки UTC, дни 1–26** (`0 5,13,21 1-26 * *`). Отчёт в Telegram.
- Job timeout **95 мин**. Catalog: `--phase=primary --limit=1200 --maxMinutes=80`.
- `BL_PAUSE_MS=400,800`, `BL_HTTP_FETCH=1`, `BL_HTTP_429_RETRIES=1`, `BL_HTTP_429_MIN_MS=15000`, `BL_HTTP_429_MAX_MS=30000`, `BL_GAP_QUEUE_RATIO=0.7`.
- Retry: limit **20**, maxMinutes **5**. Queue: 15 / 8 min.
- KPI в конце окна. Playwright: `--with-deps` только если кэш пуст.

### Локально (после 26-го / добор)

```bash
npm run ingest:bricklink:catalog -- --confirm --phase=auto --limit=350 --maxMinutes=90
npm run ingest:bricklink:retry-errors -- --confirm --phase=auto --limit=80 --maxMinutes=30
npm run ingest:bricklink:month-gaps
```

После Oops-волны — пауза 10–15 мин (`LOCAL_WIFI.md`).

---

## Pro refresh

- Быстро / надёжно / полный разбор PG (без catalog `fastFail`).
- Доступ: `users.pro` / `plan=pro` **или** moderator+.
- В карточке только BIF.

---

## Что не делаем сейчас

- Ежемесячный full pass всех 54k на GHA  
- 2–3 источника цен  
- Скрейп новинки до launch+2d  
- Показ сырого Price Guide как «цена набора»  
- Авто-secondary (BOX/…) по расписанию  
- «View older version» на BrickLink (дыры старых лет)

Идеи (set+box UX, чаще TTL, multi-source, Pro-график) — в `STRATEGY.md` (идея 15 / P3).
