# BrickInFuture — публичный парсер BrickLink (raw-only)

Собирает вторичный рынок BrickLink (**sold** = совершённые сделки, **stock** =
цены на витрине) и пишет **сырьё** в облачную базу Firestore. **Оценку BIF**
(нашу цену в карточке) считает закрытая сторона — Cloud Function на приватном
проекте. Формулы тут нет: репозиторий можно держать публичным ради бесплатных
безлимитных минут GitHub Actions.

> Этот код сгенерирован из основного (закрытого) репозитория командой
> `npm run parser:export-public`. Правки вносите там, потом пересобирайте.

## Как это работает
1. Playwright один раз проходит защиту BrickLink → берёт токен.
2. Дальше страницы Price Guide берутся обычным HTTP с этим токеном (быстро).
3. Пишем помесячные точки в `market_observations/{id}__bricklink/monthly/{YYYY-MM}`.
4. Приватный триггер `onMarketMonthlyWritten` считает BIF и пишет `bif_prices`.

Всегда работает в режиме **BL_RAW_ONLY=1** (см. workflow) — без расчёта BIF.

## Что нужно один раз настроить (GitHub Secrets)
Репозиторий → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**:

- **FIREBASE_SERVICE_ACCOUNT_DEV** (обязательно) — JSON сервис-аккаунта dev-проекта
  Firebase. Firebase Console → Project settings → Service accounts →
  Generate new private key → скопировать всё содержимое файла в значение секрета.
- **TELEGRAM_BOT_TOKEN** и **TELEGRAM_CHAT_ID** (необязательно) — отчёт после
  прогона. Токен даёт @BotFather (https://t.me/BotFather), chat id — ваш чат.
- **BL_PROXY_URL** (необязательно, на будущее) — резидентский прокси
  `http://user:pass@host:port`. Без него HTTP-путь на GitHub тоже работает.

## Запуск
Расписание уже настроено (3×/сутки, дни 1–26 UTC). Вручную:
GitHub → **Actions** → *BrickLink parser (public, raw-only)* → **Run workflow**.

## Локально
```bash
npm install
npx playwright install --with-deps chromium
# положите ключ сервис-аккаунта и укажите путь:
export GOOGLE_APPLICATION_CREDENTIALS=./sa.json
export BL_RAW_ONLY=1
npm run ingest:bricklink:catalog -- --confirm --phase=primary --limit=50
```
