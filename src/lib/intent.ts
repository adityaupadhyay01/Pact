import { z } from "zod";
import { OperatorSchema, type Constraint, type Requirements } from "./contract";
import { normalizeUnit } from "./units";

/**
 * Raw intent as returned by the language model. Everything here is untrusted
 * until `groundIntent` checks it against the buyer's own words.
 */
export const RawIntentSchema = z.object({
  isShoppingRequest: z.boolean(),
  product: z.string().nullable(),
  productQuote: z.string().nullable(),
  searchQuery: z.string().nullable(),
  budget: z
    .object({
      max: z.number(),
      currency: z.string(),
      userQuote: z.string(),
    })
    .nullable(),
  constraints: z
    .array(
      z.object({
        label: z.string(),
        attribute: z.string(),
        operator: OperatorSchema,
        value: z.string().nullable(),
        unit: z.string().nullable(),
        mandatory: z.boolean(),
        userQuote: z.string(),
      }),
    )
    .max(12),
  /** Set when the request is too vague to search for (e.g. "something nice"): one short question to ask. */
  clarificationQuestion: z.string().nullable(),
});
export type RawIntent = z.infer<typeof RawIntentSchema>;

/**
 * This MVP searches US merchants and pays through PayPal Sandbox in US dollars,
 * so budgets are USD only. Other currencies are refused, never converted.
 */
export const SUPPORTED_CURRENCIES = ["USD"];

/** Currency words and symbols a buyer might write. "$" is read as USD (US-only MVP). */
const CURRENCY_MARKERS: [string, RegExp][] = [
  ["CAD", /\bcad\b|\bc\$|canadian dollars?/i],
  ["AUD", /\baud\b|\ba\$|australian dollars?/i],
  ["EUR", /€|\beur\b|\beuros?\b/i],
  ["GBP", /£|\bgbp\b|\bpounds? sterling\b|\bquid\b/i],
  ["INR", /₹|\binr\b|\brupees?\b/i],
  ["USD", /\$|\busd\b|\bdollars?\b|\bbucks?\b/i],
];

/** The currency the buyer actually wrote in this quote, if any. */
export function currencyIn(quote: string): string | null {
  return CURRENCY_MARKERS.find(([, re]) => re.test(quote))?.[0] ?? null;
}

/** True when the unit (or a spelling of it) appears in the buyer's words, e.g. "GB" in "16gb", "%" in "70 percent". */
export function unitAppearsIn(unit: string, quote: string): boolean {
  const want = normalizeUnit(unit);
  if (!want) return false;
  if (want === "%" || want === "percent") return /%|\bpercent\b|\bpct\b/i.test(quote);
  const tokens = quote
    .toLowerCase()
    .replace(/(\d)([a-z"])/g, "$1 $2")
    .split(/[^a-z"]+/)
    .filter(Boolean);
  return tokens.some((t) => normalizeUnit(t) === want);
}

/**
 * A cheap, deterministic check before any AI call: is there anything here a
 * person could be asking to buy? Rejects empty, symbol-only and keyboard-mash input.
 */
export function precheckRequest(text: string): { ok: true } | { ok: false; message: string } {
  const words = text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  const real = words.filter((w) => /[aeiouy]/.test(w) && !/(.)\1{3,}/.test(w) && !/[bcdfghjklmnpqrstvwxz]{5,}/.test(w));
  if (real.length === 0 || real.join("").length < 3) {
    return {
      ok: false,
      message: "PACT couldn't find a product in that. Describe what you want to buy, for example “running shoes, size 9, under $120”.",
    };
  }
  return { ok: true };
}

export type IntentOutcome =
  | { ok: true; requirements: Requirements; dropped: { what: string; reason: string }[]; notes: string[] }
  | { ok: false; reason: "not_shopping" | "not_understood" | "needs_clarification"; message: string };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** True when `quote` literally appears in `text` (case and whitespace insensitive). */
export function appearsIn(quote: string | null | undefined, text: string): boolean {
  if (!quote || !quote.trim()) return false;
  return norm(text).includes(norm(quote));
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};
const digitsOf = (s: string) => [
  ...(s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((d) => Number(d.replace(",", "."))),
  ...(s.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/g) ?? []).map((w) => WORD_NUMBERS[w]),
];

/** The number must literally appear in the quote, so a model can't invent "70" from "dark". */
function numberAppearsIn(n: number, quote: string): boolean {
  return digitsOf(quote).some((d) => Math.abs(d - n) < 1e-9);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60) || "requirement";

/**
 * Turn an untrusted model intent into requirements, keeping only what the
 * buyer actually said. Never invents a budget, a spec or a product.
 */
export function groundIntent(raw: RawIntent, text: string): IntentOutcome {
  if (!raw.isShoppingRequest) {
    return {
      ok: false,
      reason: "not_shopping",
      message: "This doesn't look like something to buy. Describe a product, what matters to you, and your budget.",
    };
  }
  const product = raw.product?.trim();
  const question = raw.clarificationQuestion?.trim();
  if (question && (!product || !appearsIn(raw.productQuote, text))) {
    return { ok: false, reason: "needs_clarification", message: `Your request is too open to search for. ${question.slice(0, 200)}` };
  }
  if (!product || !appearsIn(raw.productQuote, text)) {
    return {
      ok: false,
      reason: "not_understood",
      message: "PACT couldn't tell what you want to buy. Name the product, for example “a 70% dark chocolate bar”.",
    };
  }

  const dropped: { what: string; reason: string }[] = [];
  const notes: string[] = [];

  // Budget: only if the buyer wrote it, with the number in their words.
  let budget: Requirements["budget"] = null;
  if (raw.budget) {
    const b = raw.budget;
    const currency = b.currency.trim().toUpperCase();
    // The currency comes from the buyer's words, not the model's guess.
    const written = appearsIn(b.userQuote, text) ? currencyIn(b.userQuote) : null;
    if (!appearsIn(b.userQuote, text) || !numberAppearsIn(b.max, b.userQuote) || !(b.max > 0)) {
      dropped.push({ what: `budget ${b.max} ${currency}`, reason: "not found in your words" });
    } else if (!written) {
      dropped.push({ what: `budget ${b.max}`, reason: "no currency in your words, so PACT asks instead of assuming" });
    } else if (!SUPPORTED_CURRENCIES.includes(written)) {
      dropped.push({ what: `budget in ${written}`, reason: "this version only supports US dollars (US merchants)" });
    } else {
      budget = { max: b.max, currency: written, scope: "item_price", origin: "request", userQuote: b.userQuote.trim() };
    }
  }

  // Constraints: each must quote the request; numeric ones must contain their number.
  const constraints: Constraint[] = [];
  const seen = new Set<string>();
  for (const c of raw.constraints) {
    const label = c.label.trim().slice(0, 60);
    if (!appearsIn(c.userQuote, text)) {
      dropped.push({ what: label || c.attribute, reason: "not found in your words" });
      continue;
    }
    // A price constraint duplicates the budget; budget is handled separately.
    if (/^(price|budget|cost|total|max_price)$/.test(slug(c.attribute))) continue;
    const numeric = c.operator === "gte" || c.operator === "lte";
    const value = c.value?.trim() || null;
    if (c.operator !== "present" && !value) {
      dropped.push({ what: label, reason: "no value given" });
      continue;
    }
    if (numeric && (!value || !Number.isFinite(Number(value)) || !numberAppearsIn(Number(value), c.userQuote))) {
      dropped.push({ what: label, reason: "the number isn't in your words" });
      continue;
    }
    // A unit must be in the buyer's words too. "16 RAM" stays unit-less, and PACT then says it can't compare it.
    let unit = c.unit?.trim() || null;
    if (unit && !unitAppearsIn(unit, c.userQuote)) {
      notes.push(`“${label}”: the unit ${unit} isn't in your words, so PACT didn't assume it.`);
      unit = null;
    }
    const attribute = slug(c.attribute);
    const key = `${attribute}:${c.operator}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    constraints.push({
      id: `c${constraints.length + 1}`,
      label: label || attribute,
      attribute,
      operator: c.operator,
      value: c.operator === "present" ? null : value,
      unit,
      mandatory: c.mandatory,
      origin: "request",
      userQuote: c.userQuote.trim().slice(0, 200),
    });
    if (constraints.length >= 10) break;
  }

  if (!budget) notes.push("No budget found in your request. Add one before PACT can check a purchase.");

  const searchQuery = (raw.searchQuery?.trim() || product).slice(0, 120);
  return {
    ok: true,
    requirements: { product: product.slice(0, 120), searchQuery, constraints, budget },
    dropped,
    notes,
  };
}
