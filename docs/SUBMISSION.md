# Devpost submission draft — PACT

> Fill in the links marked TODO before submitting. Only describe an integration as live if it worked in the hosted demo.

**Project name:** PACT
**Tagline:** You tell it what you want, AI finds it, PACT checks it, and you approve the payment.

**Links**
- Demo video (YouTube, public, under 3 min): TODO
- Hosted demo: TODO
- Code (public, MIT license): TODO

---

## Inspiration

AI agents are starting to buy things for people. Payment rails answer *did the money move?* Nobody checks whether the purchase is the one the buyer asked for, or whether the agent was steered by a seller's page. We wanted a layer between the agent and the payment that protects **intent**, not just the transaction.

## What it does

PACT sits between an AI shopping agent and PayPal checkout:

1. **Any request, grounded in your words.** Type what you want in plain language. Gemini turns it into requirements and a budget, and each one must quote your request. Nothing is invented: no budget means PACT asks for one.
2. **Real products.** PACT searches the Channel3 catalog. A Gemini shopping agent picks one and explains its reasons.
3. **Verification.** PACT lines up your request, the seller's listing, what the agent claimed and the price. Gemini extracts facts, each with an exact quote from the listing, and a deterministic rule engine returns **Match**, **Check first** or **Blocked**. Hidden instructions aimed at AI agents are detected and blocked.
4. **You approve, PayPal pays, PACT confirms.** After you approve the item price, PayPal Sandbox runs the payment. Before capture, PACT reads the order from PayPal and compares amount, currency and the approval hash (`custom_id`) to the cent. A mismatch stops the payment.
5. **Signed receipt.** Every step is in a hash-chained log signed by the server. Any edit is detected.
6. **Seller Mode for judges.** A labelled security test that turns a copy of the agent's pick into a dishonest seller: hidden instructions, fine print that contradicts a requirement, or a PayPal amount higher than approved. All of it is marked TEST.

**Honest limits:** PACT verifies the catalog item price, not shipping, tax or the merchant's checkout total. The sandbox payment demonstrates the approval and verification flow; it does not place an order with the merchant. Without AI, PACT refuses to check rather than guess.

## How we built it

- **Next.js 16 + TypeScript**, **Tailwind CSS**, **Motion**, and **AG Grid** for the audit table of every product checked.
- **PayPal Orders v2 API and JS SDK (Sandbox):** order creation, server-side order retrieval for verification, idempotent capture.
- **Google Gemini** (`gemini-3.5-flash-lite`) with JSON-schema structured output validated by **Zod**: request reading, the agent's choice and grounded fact extraction.
- **Channel3** product search and product detail (prices refreshed before approval, no cross-session caching).
- **Supabase Postgres** for sessions and rate limits.
- **Vitest** unit tests and **Playwright** end-to-end tests, including payment-safety cases, keyboard-only use and an axe WCAG 2.2 AA scan.

## Challenges we ran into

- **Keeping AI out of the decision.** The model extracts and explains; code decides. Missing facts are "Check first", never "Match".
- **Hallucinated requirements and specs.** Every requirement must quote the buyer, and every fact must quote the listing. Both are checked in code.
- **Free-form requests.** Moving from one fixed product type to any request meant generic requirements (attribute, operator, value, unit) with unit conversion.
- **Trusting the order.** The seller's checkout creates the PayPal order, so PACT re-reads it from PayPal instead of trusting it.

## Accomplishments that we're proud of

- A working flow from a plain-language request to a verified PayPal capture, with a tamper-evident receipt.
- A bait-and-switch that only the pre-capture PayPal check catches.
- Every verdict cites the exact words it relied on, from the buyer and from the listing.

## What we learned

Intent is a missing primitive in payments. Agentic commerce needs requirements the agent can't rewrite and a check at the moment money moves.

## What's next for PACT

- Verifying the full merchant checkout total (shipping, tax, fees) through merchant integrations.
- A PACT gateway SDK so any agent framework can route payments through it.
- Evidence packages for dispute resolution, and merchant-signed listings.

## Built with

`nextjs` `typescript` `paypal` `paypal-orders-api` `gemini` `channel3` `zod` `supabase` `ag-grid` `tailwindcss` `vitest` `playwright` `vercel`

## Tools — AI and how we used it

- **Google Gemini:** reads the buyer's request into grounded requirements, acts as the shopping agent that picks a product, and extracts listing facts with exact quotes. All outputs are schema-constrained and validated. Gemini never decides whether a payment proceeds. Free tier: Google may use prompts to improve its products, so users are told not to enter personal details.
- **Claude Code** was used as a coding assistant during development.
