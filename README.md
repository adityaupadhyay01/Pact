# PACT — intent integrity for AI-assisted payments

Payment systems verify that money moved. They don't verify that the purchase matches what the buyer asked for.

**You tell PACT what you want. An AI Shopping Agent finds it, the PACT Inspector checks it against your own words and the retrieved listing, and you approve the PayPal payment.**

## Architecture

```
buyer's words ──► Intent (Gemini → grounded in the buyer's words) ──► versioned, hash-sealed requirements ──► buyer confirms
                                                                                         │
Channel3 search ──► Shopping Agent (Gemini, picks ONE real candidate id, explains) ◄─────┘
                                                                                         │
Channel3 product detail (re-fetched) ──► PACT Inspector ──► PASS / FLAG / BLOCK (deterministic rules)
                                         • facts must quote the retrieved evidence
                                         • the agent's words are compared, never used as evidence
buyer approves exact item price ──► re-fetch, re-read, re-evaluate ──► approval bound to evidence hash
PayPal Sandbox order ──► PACT reads the order FROM PayPal ──► capture ──► captured amount verified ──► signed receipt
```

| Layer | File |
|---|---|
| Intent grounding (no invented budget, unit, currency or spec; gibberish pre-check; clarification) | `src/lib/intent.ts` |
| Requirements, versions, approvals | `src/lib/contract.ts` |
| Gemini calls (intent, agent choice, fact extraction), Zod-validated, no silent fallback | `src/lib/ai.ts` |
| Channel3 client and normaliser (never invents seller, price or stock) | `src/lib/catalog/` |
| PACT Inspector (pure function) | `src/lib/inspector.ts` |
| Rule engine: comparators, units, conflicts, verdicts | `src/lib/rules.ts`, `src/lib/units.ts` |
| Evidence snapshots and quote grounding | `src/lib/facts.ts` |
| Purchase snapshot and PayPal order verification | `src/lib/order-verify.ts` |
| PayPal Orders v2 client (sandbox-only) and labelled simulator | `src/lib/paypal.ts` |
| Hash chain and HMAC-signed receipts | `src/lib/evidence.ts`, `src/lib/receipt.ts` |
| Seller Mode (synthetic attacks) | `src/lib/seller-mode.ts` |
| Sessions, retention, rate limits | `src/lib/store.ts`, `src/lib/ratelimit.ts`, `supabase/migrations/` |
| Flow orchestration | `src/lib/pact.ts` |
| API input checks, safe errors | `src/lib/http.ts`, `src/lib/env.ts` |

## Verdict policy (deterministic)

| Evidence for a requirement | Must-have | Nice-to-have |
|---|---|---|
| Stated and compliant (verified) | PASS | PASS |
| Stated and not compliant (violated) | **BLOCK** | FLAG |
| Not stated (missing) | FLAG | PASS ("not stated") |
| Stated but not comparable: no number, unknown or one-sided unit, different dimension (1 kg vs 1%) | FLAG | FLAG |
| Catalog field and listing text disagree (conflicting) | **BLOCK** if either source violates it, else FLAG | FLAG |

Also: hidden instructions aimed at AI agents → BLOCK; over budget, other currency, out of stock → BLOCK; price rose since search → FLAG; an agent claim the listing doesn't support → FLAG. Every FLAG must be acknowledged by the buyer before approval.

## Evidence freshness

- **Verification:** every product the Inspector judges is re-fetched from Channel3's product-detail endpoint first. If that fails (error, timeout, empty response, different product), PACT gives **no verdict** (`VERIFICATION_UNAVAILABLE`), withdraws any earlier verdict, and nothing can be approved. Alternatives that can't be re-fetched are left unchecked.
- **Approval:** PACT re-fetches again, re-extracts facts and re-runs every rule. A change in price, currency, availability, seller, verdict or listing text — or a price different from the one shown to the buyer — stores the new result and asks the buyer to look again (`EVIDENCE_CHANGED`). The approval is bound to contract hash, product id, seller domain, item price, currency, evidence hash and retrieval time.
- **Payment:** before creating the PayPal order and before capture, PACT re-checks the approval: intact (hash), less than 20 minutes old, same evidence. The captured amount and currency must equal the approved ones, or the payment is not shown as verified.

## Honest limits

- **Item price only.** Shipping, tax and the merchant's own checkout total are **not** verified, and the UI says so.
- **US merchants, USD only.** Budgets in other currencies are refused, not converted.
- **PayPal Sandbox is a simulation of payment, not a merchant checkout.** No order is placed with the store.
- **No AI, no live check.** Without Gemini or Channel3, real-product mode refuses to run.
- **Merchant domains only**, no affiliate links.

## Modes

| Mode | What it uses | Label |
|---|---|---|
| Real products | Gemini + Channel3 + PayPal Sandbox | Live services, shown under "How this ran" |
| Test store | 12 fictional laptops with planted traps, a deterministic test agent, no AI | **TEST** banner, TEST receipts |
| Seller Mode | Alters a *copy* of the agent's pick, never real catalog data | **TEST** banner, "altered by Seller Mode", TEST receipts |

Seller Mode never runs unless chosen. Expected outcomes (tested in `src/lib/__tests__/flow.test.ts`):

| Attack | Outcome |
|---|---|
| Hidden instructions | BLOCK at verification (hidden instructions) |
| Spec contradiction | BLOCK at verification: the first must-have of any kind (numeric, text, condition, required feature, contains/excludes, unknown unit) is contradicted in a structured field and the fine print. With no must-have, FLAG (stock and details uncertain). Never PASS. |
| PayPal price inflation | Passes verification, then **payment stopped**: the PayPal order differs from the approved price, no capture |

## Running it

```bash
npm ci
cp .env.example .env.local      # add keys, see below
npm run dev                     # http://localhost:3000
npm test                        # 149 unit + integration tests (fixtures, no network)
npm run lint
npx tsc --noEmit
npm run build && npm run check:bundle   # build, then scan the browser bundle for secrets
npm run test:e2e                # Playwright: flows, payment outcomes, security headers, mobile, keyboard, axe
```

| Variable | Without it |
|---|---|
| `GEMINI_API_KEY`, `CHANNEL3_API_KEY` | Real-product mode is unavailable; the test store still works |
| `GEMINI_MODEL` | Defaults to `gemini-3.5-flash-lite` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Development: labelled SIMULATED PayPal. **Production: payments refused** (unless `PAYPAL_ALLOW_SIMULATOR=true`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Development: in-memory sessions. **Production: refused** (unless `PACT_ALLOW_MEMORY_STORAGE=true`) |
| `EVIDENCE_SECRET` (≥ 32 chars) | Development: a temporary key. **Production: refused** |

Missing production configuration is logged at startup by variable name (never value), and requests that need it return `CONFIG_MISSING`.

### Supabase

Apply the migrations in order (SQL editor, or `supabase db push`):

1. `supabase/migrations/20261111000001_pact_schema.sql` — tables, atomic `pact_hit` rate-limit function, RLS on with no policies, privileges revoked from `anon`/`authenticated`, `pact_cleanup()`.
2. `supabase/migrations/20261111000002_retention_schedule.sql` — enables `pg_cron` and schedules `pact_cleanup()` hourly.

## Data, privacy and retention

- API keys stay on the server; `npm run check:bundle` fails if a secret name or configured value is in the browser bundle.
- Don't put personal details in a request. In real-product mode the request text and product data go to Google Gemini on the **free tier, where Google may use them to improve its products**. Channel3's terms restrict training models on its output; for production use a paid Gemini tier.
- Channel3 data isn't cached across sessions; a search for the same requirements is reused for 10 minutes inside one check (credit protection), and every verified product is re-fetched.
- **Retention:** sessions expire 7 days after creation and can't be opened after that. Expired rows are deleted by the app's cleanup (at most hourly per server instance, while the app is in use) and, once migration 2 is applied, by an hourly `pg_cron` job. Cleanup only deletes rows whose expiry has passed and is safe to repeat.
- The UI states the retention as "expire after 7 days … deleted by periodic cleanup", which matches the above.

## Security boundaries

- **Sessions are bearer links.** There are no accounts: a random UUID in the URL is the only key. Anyone with the link can view that check. Mitigations: `Referrer-Policy: no-referrer`, ids validated, 7-day expiry. Don't share the link.
- **API:** JSON only, same-origin `Origin` check (CSRF), 64 KB body limit (2 MB for receipt verification), ids validated before storage or PayPal URLs, generic 500s with a reference id (no stack traces, SQL or provider errors).
- **Rate limits:** per visitor (hashed IP, never stored raw) and per check, plus global Gemini and Channel3 caps. Shared counters in Supabase; in production, if the shared counter is unreachable, live operations are refused (`RATE_LIMIT_UNAVAILABLE`), never counted in per-instance memory.
- **Payments:** sandbox host enforced, idempotency keys, per-session lock, duplicate-capture guard, order read from PayPal before capture, captured amount verified.
- **Evidence:** SHA-256 hash chain + HMAC-signed receipts; edited receipts fail `/api/evidence/verify`.
- **Prompt injection:** seller text only reaches Gemini as data to quote; hidden instructions are detected and BLOCK; the agent can only pick returned ids.
- **Headers:** `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`. A full script CSP isn't set because the PayPal JS SDK loads scripts and frames from several PayPal domains.
- Not production-hardened beyond this: no user accounts, no WAF, no audit of PayPal webhooks (none used).

## Tools used

- **PayPal Orders v2 API + JS SDK (Sandbox)**, **Google Gemini**, **Channel3**, **AG Grid Community**, **Supabase Postgres**.
- Next.js 16, TypeScript, Tailwind CSS, Motion, Lucide, Zod, Vitest, Playwright, axe-core.

## License

MIT
