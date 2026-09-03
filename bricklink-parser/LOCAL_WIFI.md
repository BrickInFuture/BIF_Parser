# Local Wi‑Fi BrickLink ingest

Canonical rules (TTL, novelty, GHA calendar): **[PARSING_RULES.md](./PARSING_RULES.md)**.

Lessons from the 1000-SET home Wi‑Fi run (`out/local_wifi_1000_*.log`):

## Batch size

Prefer **`--limit=300`…`500`**, not 1000 in one sitting. Long continuous scrapes heat the IP; Oops waves then burn most of the remaining limit.

## After an Oops / circuit storm

When logs show long `Oops, Sorry!` streaks or `circuit_cool_soft_block`:

1. **Pause 10–15 minutes** (or longer) before the next catalog chunk.
2. Do **not** immediately resume into a hot cursor — e.g. after the Aug 2026 run the cursor sat at **`SET_2378-1`** mid-Oops wave; the next `--limit` would start blocked again.
3. Prefer `retry-errors` only **after** cool-down; soft-blocked Oops items should now trip circuit cool (not only 15–30s fail backoff).

## GitHub Actions

Days **1–15**: scheduled primary ingest (see PARSING_RULES). Days **16+**: finish here locally. Without `BL_PROXY_URL`, GHA soft-blocks waste free minutes.

## Useful commands

```bash
# After the 15th — local catch-up (SET+MINIFIG / auto)
npm run ingest:bricklink:catalog -- --confirm --phase=auto --limit=350 --maxMinutes=90

# Secondary BOX/INSTRUCTION/GEAR (local only; not on GHA budget)
npm run ingest:bricklink:catalog -- --confirm --phase=secondary --limit=200 --maxMinutes=90

# Month-gap audit (novelties)
npm run ingest:bricklink:month-gaps
```
