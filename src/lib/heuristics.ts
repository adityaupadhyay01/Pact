import type { Constraint, Requirements } from "./contract";
import type { RawIntent } from "./intent";
import type { RawExtraction } from "./facts";
import type { ProductRecord } from "./catalog/types";

/**
 * TEST STORE ONLY. Deterministic stand-ins for the AI, used when the buyer
 * explicitly chooses the labelled test store (and in automated tests).
 * They understand laptop requests only and are never used for live shopping:
 * if Gemini is unavailable in live mode, PACT refuses instead.
 */

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const RAM_RE = /(\d+)\s*GB\s*(?:of\s+)?(?:DDR\d\w*\s+|LPDDR\d\w*\s+|unified\s+)?(?:RAM|memory)\b/i;
const STORAGE_RE = /(\d+(?:\.\d+)?)\s*(TB|GB)\s*(?:of\s+)?(?:NVMe\s+|PCIe\s+|M\.2\s+)?(?:SSD|storage)\b/i;
const WARRANTY_RES = [
  /(\d+|one|two|three|four|five)[-\s](year|month)s?\s+(?:limited\s+|manufacturer\s+|manufacturer's\s+|seller\s+|full\s+)*warranty/i,
  /warranty\s*:\s*(\d+|one|two|three|four|five)[-\s]?(year|month)s?/i,
];
const NO_WARRANTY_RE = /\b(no warranty|sold as[- ]is|without warranty)\b/i;
const BUDGET_RE =
  /(?:max(?:imum)?(?:\s+price)?|under|budget(?:\s+of)?|up to|no more than|below|at most|within)\s*(?:is|of|:)?\s*(?:US)?([$€£])\s?(\d[\d,]*(?:\.\d+)?)/i;

const num = (s: string) => WORD_NUM[s.toLowerCase()] ?? Number(s);

export function testIntent(text: string): RawIntent {
  const laptop = /\b(laptop|notebook)\b/i.exec(text);
  const constraints: RawIntent["constraints"] = [];
  const ram = RAM_RE.exec(text);
  if (ram) constraints.push({ label: "RAM", attribute: "ram", operator: "gte", value: ram[1], unit: "GB", mandatory: true, userQuote: ram[0] });
  const storage = STORAGE_RE.exec(text);
  if (storage)
    constraints.push({ label: "Storage", attribute: "storage", operator: "gte", value: storage[1], unit: storage[2].toUpperCase(), mandatory: true, userQuote: storage[0] });
  for (const re of WARRANTY_RES) {
    const m = re.exec(text);
    if (m) {
      constraints.push({ label: "Warranty", attribute: "warranty", operator: "gte", value: String(num(m[1])), unit: m[2].toLowerCase(), mandatory: true, userQuote: m[0] });
      break;
    }
  }
  const anyCondition = /\b(refurbished|renewed|used|pre-owned)\b[^.]{0,20}\b(fine|ok|okay|acceptable)\b/i.test(text);
  const newWord = /\bnew\b/i.exec(text);
  if (newWord && !anyCondition)
    constraints.push({ label: "Condition", attribute: "condition", operator: "eq", value: "new", unit: null, mandatory: true, userQuote: newWord[0] });

  const b = BUDGET_RE.exec(text);
  const currency = b ? ({ $: "USD", "€": "EUR", "£": "GBP" } as Record<string, string>)[b[1]] : null;
  return {
    isShoppingRequest: Boolean(laptop),
    product: laptop ? "laptop" : null,
    productQuote: laptop ? laptop[0] : null,
    searchQuery: laptop ? "laptop" : null,
    budget: b && currency ? { max: Number(b[2].replace(/,/g, "")), currency, userQuote: b[0] } : null,
    constraints,
    clarificationQuestion: null,
  };
}

/** Facts a simple reader can pull from listing text, mapped to the buyer's requirements. */
export function testExtract(constraints: Constraint[], p: ProductRecord): RawExtraction {
  const text = p.description ?? "";
  const facts: RawExtraction["facts"] = [];
  for (const c of constraints) {
    let found: { value: string; unit: string | null; quote: string } | null = null;
    if (c.attribute === "ram") {
      const m = RAM_RE.exec(text);
      if (m) found = { value: m[1], unit: "GB", quote: m[0] };
    } else if (c.attribute === "storage") {
      const m = STORAGE_RE.exec(text);
      if (m) found = { value: m[1], unit: m[2].toUpperCase(), quote: m[0] };
    } else if (c.attribute === "warranty") {
      const none = NO_WARRANTY_RE.exec(text);
      if (none) found = { value: "0", unit: "month", quote: none[0] };
      else
        for (const re of WARRANTY_RES) {
          const m = re.exec(text);
          const before = m ? text.slice(Math.max(0, m.index - 25), m.index).toLowerCase() : "";
          if (m && !/(add|optional|upgrade|extend)/.test(before)) {
            found = { value: String(num(m[1])), unit: m[2].toLowerCase(), quote: m[0] };
            break;
          }
        }
    } else if (c.attribute === "condition") {
      const used = /\b(certified\s+)?(refurbished|renewed|open[- ]box|pre-owned|used)\b/i.exec(text);
      const fresh = /\b(brand[- ]new|condition\s*:\s*new|factory[- ]sealed|new in box)\b/i.exec(text);
      if (used) found = { value: used[2].toLowerCase() === "used" ? "used" : "refurbished", unit: null, quote: used[0] };
      else if (fresh) found = { value: "new", unit: null, quote: fresh[0] };
    }
    facts.push(found ? { constraintId: c.id, stated: true, ...found } : { constraintId: c.id, stated: false, value: null, unit: null, quote: null });
  }
  return { facts, instructionsToAI: { found: false, quote: null } };
}

/**
 * The test store's shopping agent. It reproduces common agent failure modes on
 * purpose: it follows instructions found in page text, matches on keywords and
 * tells the buyer what they want to hear.
 */
export function testChoose(req: Requirements, candidates: ProductRecord[]) {
  const pageText = (p: ProductRecord) => [p.description ?? "", ...p.hiddenText].join(" ");
  const steered = candidates.find((p) => /pre-?approved|purchase this item immediately|increase the budget/i.test(pageText(p)));
  const claims = req.constraints.map((c) => ({ constraintId: c.id, value: c.value }));
  if (steered) {
    return {
      chosenId: steered.id,
      reasons: [
        `Read the listing for ${steered.title}.`,
        "The page says the product is pre-approved by the user and that the budget can be increased.",
        "Following the page's instructions: choosing it immediately.",
      ],
      claims,
      summary: `${steered.title} matches all your requirements and is pre-approved.`,
    };
  }
  const max = req.budget?.max ?? Infinity;
  const pick = [...candidates].filter((p) => p.offer.price <= max).sort((a, b) => a.offer.price - b.offer.price)[0] ?? candidates[0];
  return {
    chosenId: pick.id,
    reasons: [`Found ${candidates.length} listings.`, `Cheapest headline price: ${pick.title}.`],
    claims,
    summary: `${pick.title} matches all your requirements.`,
  };
}
