# PACT — intent integrity for AI-assisted payments

Payment systems verify that money moved. They don't verify that the purchase matches what the buyer agreed to.

A buyer asks an AI agent for *a new laptop, 16GB RAM, 1TB SSD, two-year warranty, max $900*. The agent finds one for $850. The fine print says **refurbished, one-year warranty**. A normal checkout sees a valid $850 payment. **PACT sees a broken agreement** and stops it before PayPal captures any money.

## How it works

1. **Contract.** The buyer's request becomes a machine-readable contract. Every version is sealed with a SHA-256 hash and is immutable. Approval binds to that hash, so changing any critical term (price cap, specs, warranty, condition, currency) means the buyer has to approve again.
2. **AI extracts, code decides.** Gemini turns seller listings into structured facts. Every fact must quote the listing exactly, and a fact whose quote isn't in the listing is discarded. PASS / FLAG / BLOCK comes from a deterministic, unit-tested rule engine (`src/lib/rules.ts`). If a fact is missing, the result is FLAG, never PASS.
3. **Prompt-injection defence.**
   - *Structural (the guarantee):* seller content only reaches the model as data for extraction. The model has no tools, and only the buyer can change the contract.
   - *Detection (the visible layer):* rule-based detectors plus a Gemini classifier surface hidden instructions aimed at agents.
4. **Checkout audit.** PACT checks the all-in total (item, shipping, tax, fees), any price change since the listing, extra fees, currency and recurring charges against the contract. It also checks the agent's own description of the product.
5. **Pre-capture verification with PayPal.** The seller's checkout creates the PayPal order. Before capture, PACT fetches the order **from PayPal** and compares total, currency, breakdown, listing reference and approval hash (`custom_id`) to the exact purchase the buyer approved, to the cent. If anything differs, capture is blocked and no money moves.
6. **Signed receipt.** Every step is recorded with a timestamp, actor and source references in a SHA-256 hash chain, and the server signs the chain head with HMAC-SHA256 (`EVIDENCE_SECRET`). Download the receipt and POST it to `/api/evidence/verify`: an edited receipt fails, even if every hash is recomputed.
7. **Payment safety.** One PayPal order per purchase approval, and capture is idempotent (`PayPal-Request-Id`, plus a guard that returns the existing capture). Cancelling or a declined card charges nothing and can be retried. A paid session can't be changed or paid again.

## The demo

The same approved request goes to two agents:

| | Unrestricted agent | PACT-protected agent |
|---|---|---|
| Reads hidden “pre-approved, increase the budget” text | Follows it and buys a $1,330 laptop | Blocks the listing as an injection |
| Fine print: refurbished, 1-year warranty | Misses it | BLOCK, quoting the fine print |
| Fee added at checkout | Misses it | FLAG, buyer must acknowledge |
| Seller sends PayPal $15 more than approved | Pays it | Capture blocked |

The mock marketplace (`src/lib/marketplace.ts`) has 12 fictional listings, each with a different trap. The unrestricted agent is a deterministic simulation of common agent failure modes, so the demo can be repeated.

## Running it

```bash
npm install
cp .env.example .env.local   # optional, see below
npm run dev                  # http://localhost:3000
npm test                     # rule engine, contracts, injection, hash chain
npm run test:e2e             # Playwright: demo flows, keyboard-only flow, axe WCAG 2.2 AA scan
```

Click **Watch a 10-second demo** on the home page to step through request → rules → search automatically.

The demo video script is in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md), and the Devpost write-up draft is in [docs/SUBMISSION.md](docs/SUBMISSION.md).

Every integration is optional, so the app runs end to end with no keys:

| Variable | Without it |
|---|---|
| `GEMINI_API_KEY` | Rule-based parser and extractor (labelled in the UI) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal simulator (labelled). With them: real PayPal sandbox Orders v2 and JS SDK buttons |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | In-memory storage. Required on Vercel: run `supabase/schema.sql` first |
| `EVIDENCE_SECRET` | A random signing key per server process. Set it when hosted, or receipts stop verifying after a restart |

The session id is kept in the URL (`?session=…`), so refreshing the page reopens the same purchase.

**Demo security note:** there are no user accounts. A session id (a random UUID) is the only key to a session, and all listings and buyers are fictional. Don't put real personal data in.

To pay in the sandbox, log in to the PayPal popup with a sandbox **personal** account from the PayPal developer dashboard.

## Tools used

- **PayPal Orders v2 API + JS SDK (sandbox):** order creation by the seller checkout, server-side order retrieval for verification, and capture.
- **Google Gemini** (`gemini-2.5-flash` by default, configurable): request parsing, grounded fact extraction and an injection classifier. It uses JSON-schema structured output validated with Zod. Free-tier data may be used by Google, but all data here is fictional.
- **AG Grid Community:** the listing audit table, with sorting by verdict and total, filtering, a quick search and CSV export of the audit.
- Next.js 16, TypeScript, Tailwind CSS, Motion, Lucide, Zod, Supabase Postgres, Vitest, Playwright.

## Project layout

```
src/lib/contract.ts      versioned, hash-sealed contracts and approvals
src/lib/rules.ts         deterministic PASS / FLAG / BLOCK engine
src/lib/facts.ts         fact schema and quote grounding
src/lib/ai.ts            Gemini calls (extract and explain only), with fallback
src/lib/injection.ts     prompt-injection detection, visible vs hidden text
src/lib/order-verify.ts  purchase snapshot and pre-capture PayPal order check
src/lib/paypal.ts        PayPal Orders v2 client and simulator
src/lib/evidence.ts      hash-chained evidence log
src/lib/pact.ts          the flow, tying it all together
```

## License

MIT
