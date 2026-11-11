# PACT — 3-minute demo video script

Target length: **2:50**. Judges aren't required to watch past 3:00.
Record at 1280×800 or larger, browser zoom 100%, with dev tools hidden (use `npm run build && npm start`).

Before recording:
- Configure `GEMINI_API_KEY`, `CHANNEL3_API_KEY` and the PayPal sandbox keys. Run one real request first and check that "How this ran" shows live AI, catalog and payments. Don't say "live" on camera for anything that hasn't worked in that run.
- Pick the live request you'll use and try it once off camera (real catalog results change; choose one with a clear verdict).
- Log in to the PayPal sandbox buyer account once in the recording browser.
- Clean narration, no background music (copyright rules).

---

## 0:00 – 0:20 · The problem

**Screen:** the home page.

> "AI agents are starting to shop for us. Payment systems check that money moved, not whether we got what we asked for. PACT checks that, before the payment."

## 0:20 – 0:45 · Any request, in my own words

**Screen:** "Real products" selected. Type a request, e.g. *"Dark chocolate bar with at least 70% cocoa, under $10"*. Click **Check my purchase**.

> "I just say what I want. Gemini turns it into requirements, and every one quotes my own words. Nothing is invented: if I don't give a budget, PACT asks."

Point at "You said: …" under each requirement and the item-price note. Click **Looks right, run the check**.

## 0:45 – 1:30 · The agent picks, PACT checks

**Screen:** the progress row (searching, agent choosing, PACT checking), then step 2 and step 3.

> "PACT searches real products through Channel3. A Gemini shopping agent picks one and explains why.
> Then PACT lines up four things: my request, the seller's listing, what the agent told me, and the price. AI only extracts facts, and every fact must quote the listing. The verdict comes from deterministic rules."

Step 4: read the verdict (Match / Check first / Blocked). Open **Show details** briefly to show the quoted evidence. If there's an alternative, mention it.

## 1:30 – 2:05 · Seller Mode: a dishonest seller

**Screen:** Start over. Open **Seller Mode: security test for judges**, choose **PayPal price inflation**, run the same request. Point at the TEST banner.

> "Seller Mode is a clearly labelled security test. It makes a copy of the agent's pick behave like a dishonest seller. Here, the seller's checkout asks PayPal for more than I approved."

Choose the product, **Confirm … and continue**, **Pay with PayPal**.

> "Before capture, PACT reads the order from PayPal itself and compares it to my approval, to the cent. Payment stopped. No money moved."

(Optional, 10 s: show **Hidden instructions** being blocked in the test store.)

## 2:05 – 2:35 · The honest path and the receipt

**Screen:** back to the real request. Choose the Match, confirm the item price, pay in the PayPal Sandbox popup.

> "When everything matches, I approve the price and PayPal captures exactly that amount."

Scroll to **Evidence receipt**, click **Try editing it**.

> "Every step is in a signed, hash-chained receipt. Edit one line and verification fails."

## 2:35 – 2:50 · Close and honest limits

> "PACT checks the item price, not shipping or tax, and it says so. You tell it what you want, AI finds it, PACT checks it, and you approve the payment."

---

### If something goes wrong on camera
- Gemini or Channel3 is unavailable: PACT shows "AI unavailable" and refuses to guess. Wait, or record that segment in the test store (it's labelled TEST).
- PayPal popup is slow: keep narrating the verification step, then cut.
