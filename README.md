# PACT — intent integrity for AI-assisted payments

Payment systems verify that money moved. They don't verify that the purchase matches what the buyer asked for.

**You tell PACT what you want. An AI shopping agent finds it, PACT checks it against your own words and the seller's listing, and you approve the PayPal payment.**

Type any shopping request, for example *"dark chocolate with at least 70% cocoa, under $10"*. Gemini turns it into requirements that each quote your words. PACT searches real products through Channel3, a Gemini shopping agent picks one and explains why, and PACT verifies that pick: **Match**, **Check first** or **Blocked**, with the evidence. Only after you approve does a PayPal Sandbox payment run, and PACT checks the PayPal order against the price you approved before capturing it.

## How it works

1. **Requirements from your words only.** Gemini reads the request into structured requirements. Every requirement and the budget must quote the request word for word, and numbers must appear in that quote; anything else is dropped and shown as ignored. PACT never invents a default (no budget → it asks you). Each version is sealed with a SHA-256 hash, and your approval is bound to that hash.
2. **AI extracts, code decides.** Gemini reads the product listing into facts. Every fact must quote the listing exactly or it's discarded. PASS / FLAG / BLOCK comes from a deterministic, unit-tested rule engine (`src/lib/rules.ts`). A missing must-have is FLAG, never PASS.
3. **The agent is checked too.** The shopping agent sees the whole page, including text shoppers can't see. PACT checks its pick and each claim it made against the listing, and flags hidden instructions aimed at AI agents.
4. **Pre-capture verification with PayPal.** PACT fetches the order **from PayPal** and compares amount, currency, product reference and the approval hash (`custom_id`) with what you approved, to the cent. A mismatch blocks capture and no money moves.
5. **Signed receipt.** Every step is recorded in a SHA-256 hash chain, and the server signs the chain head with HMAC-SHA256 (`EVIDENCE_SECRET`). An edited receipt fails verification at `/api/evidence/verify`, even if every hash is recomputed.
6. **Payment safety.** Idempotent order creation and capture (`PayPal-Request-Id`), a guard against double capture, cancel and decline handled, and a paid session can't be paid again.

## Honest limits

- **Item price only.** PACT checks the catalog item price against your budget. Shipping, tax and the merchant's own checkout total are **not** verified, and the UI says so.
- **It doesn't buy from the merchant.** The PayPal Sandbox payment demonstrates the approval and verification flow; no order is placed with the store.
- **No AI, no live check.** If Gemini or Channel3 is unavailable, real-product mode refuses to run and says why. It never falls back to guessing.
- **Merchant domains only.** PACT shows the seller's domain, with no affiliate links.

## Modes

| Mode | What it uses | Label |
|---|---|---|
| Real products | Gemini + Channel3 + PayPal Sandbox | Live services, shown under "How this ran" |
| Test store | 12 fictional laptops with planted traps, a simple test agent, no AI | **TEST** banner and TEST receipts |
| Seller Mode | Alters a *copy* of the agent's pick to act like a dishonest seller: hidden instructions, fine print that contradicts a requirement, or a PayPal price higher than approved | **TEST** banner, product marked "altered by Seller Mode", TEST receipts |

Seller Mode is a security test for judges. Its synthetic evidence is always labelled and never mixed with real catalog evidence.

## Running it

```bash
npm install
cp .env.example .env.local   # add keys, see below
npm run dev                  # http://localhost:3000
npm test                     # rules, intent grounding, contracts, Seller Mode, Channel3 normaliser, receipts
npm run test:e2e             # Playwright: flows, payment safety, keyboard-only, axe WCAG 2.2 AA
```

**Watch a quick demo** on the home page runs a laptop request in the test store.

| Variable | Without it |
|---|---|
| `GEMINI_API_KEY`, `CHANNEL3_API_KEY` | Real-product mode is unavailable; the test store still works |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal simulator (labelled). With them: PayPal Sandbox Orders v2 and JS SDK buttons |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | In-memory storage. Required on Vercel: run `supabase/schema.sql` first |
| `EVIDENCE_SECRET` | A random key per server process. Set it when hosted, or receipts stop verifying after a restart |

To pay in the sandbox, log in to the PayPal popup with a sandbox **personal** account.

## Data and privacy

- All API keys stay on the server.
- Don't put personal details in a request. In real-product mode the request text goes to Google Gemini on the **free tier, where Google may use prompts and responses to improve its products**. Product data from Channel3 is also sent to Gemini for extraction.
- Channel3 data is fetched fresh for each check and is not cached across sessions; prices are refreshed before you approve.
- Sessions (including the request text) are stored for 7 days. There are no user accounts: a random session id is the only key.
- Open question we flag rather than hide: Channel3's terms restrict using its output to train models, and Gemini's free tier allows Google to use inputs for product improvement. For production, use a paid Gemini tier (no training on inputs).

## Tools used

- **PayPal Orders v2 API + JS SDK (Sandbox):** order creation, server-side order retrieval for verification, and capture.
- **Google Gemini** (`gemini-3.5-flash-lite` by default): request reading, the shopping agent's choice and grounded fact extraction, using JSON-schema structured output validated with Zod.
- **Channel3:** product search and product detail (price refresh before approval).
- **AG Grid Community:** the audit table of every checked product, one column per requirement, with sorting, filtering and CSV export.
- **Supabase Postgres:** sessions and rate limits.
- Next.js 16, TypeScript, Tailwind CSS, Motion, Lucide, Zod, Vitest, Playwright, axe-core.

## Project layout

```
src/lib/intent.ts         request → requirements, grounded in the buyer's words
src/lib/contract.ts       versioned, hash-sealed requirements and approvals
src/lib/catalog/          Channel3 client and normaliser, test store
src/lib/ai.ts             Gemini calls (intent, agent choice, extraction); no silent fallback
src/lib/facts.ts          evidence text, fact schema and quote grounding
src/lib/rules.ts          deterministic PASS / FLAG / BLOCK engine
src/lib/injection.ts      hidden-instruction detection
src/lib/seller-mode.ts    labelled synthetic seller attacks
src/lib/order-verify.ts   purchase snapshot and pre-capture PayPal order check
src/lib/paypal.ts         PayPal Orders v2 client and simulator
src/lib/evidence.ts       hash-chained, signed evidence log
src/lib/pact.ts           the flow, tying it all together
```

## License

MIT
