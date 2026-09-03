# Правила парсинга цен (BrickLink)

Канон для bulk ingest, GHA и локальных догонов. Код: `coveragePolicy.js`, `ingestCatalog.js`, `writeRawObservation.js` + `observationWriter.js` (BIF — закрыто: `functions/bifFromObservation.js`).

**Источник сейчас:** BrickLink HTML Price Guide — сводка + **все** помесячные sold-блоки на странице (не только последние 6 месяцев).  
Публично в UI — только **BIF** (не сырые avg гида).

---

## Кому когда скрейпить

| Когорт | Условие | Частота |
|--------|---------|---------|
| **Слишком рано** | есть launch, возраст **&lt; 2 суток** | **не трогать** (вторичка ещё пустая) |
| **Новинка** | launch **+2 дня … +365 дней** | **1 точка на календарный месяц** (ok или bootstrap) |
| **Зрелый** | возраст ≥ 1 год **или** нет launch | только если нет рыночного **ok** старше **~6 месяцев** (180 суток) |

Типы в GHA-окне: **только SET + MINIFIG** (экономия минут).  
BOX / INSTRUCTION / GEAR — **локально руками** после 15-го или отдельным `--phase=secondary`.

Порядок в батче: **сначала новинки и популярные темы** (`catalogPriority.js`), затем SET ↔ MINIFIG по курсору. В конце слота — короткий `retry-errors`.

---

## Нет рынка у новинки

После успешного скрейпа с пустым PG → записать BIF **`RRP × 0.9`**, метод / tag **`rrp_bootstrap_0_9`**.  
Это не sold. На следующий месяц снова пробуем живой гид.

---

## Календарь исполнения (минуты GHA)

| Дни месяца | Канал | Что |
|------------|--------|-----|
| **1–26** | **GitHub Actions по cron** (с **сентября 2026**) | primary SET+MINIFIG, HTTP token, limit 600 |
| **27–конец** | **Локально руками** (при необходимости) | добить дыры / secondary |
| **всегда** | Pro refresh (кнопка) / `workflow_dispatch` | полный качественный скрейп |

**Доставка:** Playwright один раз → WAF-токен → дальше HTTP fetch (`http_token_catalogPG`).

Лимит Free ≈ **2000 мин/мес**. При **78 окнах** × ~45–55 мин ≈ **3.5–4.5k мин** — **выше free**; нужен платный GHA или укоротить `maxMinutes`.

### Старт в сентябре

```bash
gh workflow run "BrickLink ingest" --ref main
gh run list --workflow "BrickLink ingest" --limit 5
```

Нужен секрет `FIREBASE_SERVICE_ACCOUNT_DEV`. Proxy опционален (HTTP-путь на GHA работает без).

### Параметры GHA (max, сентябрь 2026)

- Расписание: **3×/сутки UTC, дни 1–26** (`0 5,13,21 1-26 * *`). Отчёт в Telegram после прогона.
- Catalog: `--phase=primary --limit=600 --maxMinutes=45`.
- `BL_PAUSE_MS=800,1500`, `BL_HTTP_FETCH=1`, `BL_GAP_QUEUE_RATIO=0.7`.
- Retry: limit 60, maxMinutes 10. Queue: 15 / 8 min.
- KPI в конце окна. Кэш Playwright в workflow.

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
- 2–3 источника  
- Скрейп новинки до launch+2d  
- Показ сырого Price Guide как «цена набора»  
- Авто-secondary (BOX/…) на GHA в окне 1–15  

Идеи (set+box UX, чаще TTL, multi-source, Pro-график) — в `STRATEGY.md` (идея 15 / P3).
