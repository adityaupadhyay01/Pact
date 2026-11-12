import { formatMoney, toCents } from "./money";
import type { Constraint, Requirements } from "./contract";
import type { AgentClaim, Facts, Fact } from "./facts";
import type { InjectionReport } from "./injection";
import type { ProductRecord } from "./catalog/types";
import { convert, normalizeUnit, parseNumber } from "./units";

/**
 * The deterministic decision layer. Language models only supply grounded facts;
 * every PASS / FLAG / BLOCK below is plain code.
 */

export type Status = "pass" | "flag" | "block";
export type Verdict = "PASS" | "FLAG" | "BLOCK";

export interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
  expected?: string;
  actual?: string;
  /** The listing text this check relied on. */
  evidence?: string;
  /**
   * For requirement checks: what PACT knows about the evidence.
   * verified = stated and compliant; violated = stated and not compliant;
   * missing = not stated; unknown = stated but not comparable; conflicting = sources disagree.
   */
  state?: EvidenceState;
}

export type EvidenceState = "verified" | "violated" | "missing" | "unknown" | "conflicting";

export interface EvaluationInput {
  requirements: Requirements;
  product: ProductRecord;
  facts: Facts;
  /** Requirements where two evidence sources disagree (e.g. a catalog field vs the description). */
  conflicts?: Record<string, Fact[]>;
  injection: InjectionReport;
  /** Item price when the product was found; a higher price now is a change since search. */
  searchedPrice?: number;
  agentClaims?: AgentClaim[];
  agentSummary?: string;
}

export interface Evaluation {
  verdict: Verdict;
  checks: Check[];
  /** Item price in cents. Shipping, tax and checkout totals are not included. */
  totalCents: number;
}

const RANK: Record<Status, number> = { pass: 0, flag: 1, block: 2 };
const VERDICT: Record<Status, Verdict> = { pass: "PASS", flag: "FLAG", block: "BLOCK" };

export function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), "pass");
}

const OP_WORD: Record<Constraint["operator"], string> = {
  gte: "at least",
  lte: "at most",
  eq: "",
  contains: "includes",
  excludes: "without",
  present: "has",
};

export function describeRequirement(c: Constraint): string {
  if (c.operator === "present") return `has ${c.label.toLowerCase()}`;
  // "2 year" reads as a typo; time units take a plural for any value other than 1.
  const plural = c.unit && /^(year|month|week|day|hour)$/i.test(c.unit) && Number(c.value) !== 1 ? "s" : "";
  const v = `${c.value ?? ""}${c.unit ? (c.unit === "%" ? "%" : ` ${c.unit}${plural}`) : ""}`;
  return [OP_WORD[c.operator], v].filter(Boolean).join(" ");
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.]+/g, " ").trim();
const YES = /^(yes|true|included|present|available|with)$/i;
const NO = /^(no|false|not included|none|unavailable|without|n\/a)$/i;
const NEGATION = /\b(free|no|without|does not contain|doesn't contain|non)\b/i;
/** A fact that says the feature is absent ("No", "Not included", "without ANC"). */
const ABSENT = /^(no|none|false|not included|not available|unavailable|without|n\/a)\b|\b(not included|not available|does not have|doesn't have|without)\b/i;

/** Words in a text, each normalised as a unit ("cups", "gb", …). */
const wordsOf = (t: string) =>
  t
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z"%]+/)
    .filter(Boolean)
    .map((w) => normalizeUnit(w));

/** The number and unit a fact states. Falls back to the quote for the unit when the value has none. */
function factNumber(f: Fact): { value: number; unit: string | null } | null {
  const fromValue = parseNumber(f.unit ? `${f.value ?? ""} ${f.unit}` : (f.value ?? ""));
  if (fromValue && (fromValue.unit || f.unit)) return { value: fromValue.value, unit: normalizeUnit(f.unit) ?? fromValue.unit };
  // "16" with the quote "16GB RAM": take the unit from the quote when the number matches.
  const fromQuote = parseNumber(f.quote);
  if (fromValue && fromQuote && Math.abs(fromQuote.value - fromValue.value) < 1e-9) return fromQuote;
  return fromValue ?? (f.value === null ? fromQuote : null);
}

/**
 * Bring a stated number into the requirement's unit. Returns a reason instead
 * when that can't be done honestly: different dimensions (1 kg vs 1%), an
 * unknown unit, or a unit on only one side. Raw numbers are never compared across units.
 */
function inRequirementUnit(c: Constraint, got: { value: number; unit: string | null }, factText = ""): { value: number } | { why: string } {
  const reqUnit = normalizeUnit(c.unit);
  // A unit PACT has no table entry for ("cups") still counts when the fact spells the same word.
  const gotUnit = got.unit ?? (reqUnit && wordsOf(factText).includes(reqUnit) ? reqUnit : null);
  if (!reqUnit && !gotUnit) return { value: got.value };
  if (!reqUnit || !gotUnit) return { why: `one side has no unit (${reqUnit ?? "none"} vs ${gotUnit ?? "none"})` };
  if (reqUnit === gotUnit) return { value: got.value };
  const converted = convert(got.value, gotUnit, reqUnit);
  return converted === null ? { why: `can't compare ${gotUnit} with ${reqUnit}` } : { value: converted };
}

/**
 * Compare one requirement with one fact.
 * "unknown" means the fact can't be compared reliably (no number, incompatible
 * or missing units, unsupported comparison). Unknown never counts as met.
 */
export function compare(c: Constraint, f: Fact): { result: "met" | "not_met" | "unknown"; note?: string } {
  const factText = (f.value ?? f.quote).trim();
  switch (c.operator) {
    case "present":
      return ABSENT.test(factText) ? { result: "not_met" } : { result: "met" };
    case "gte":
    case "lte": {
      const want = Number(c.value);
      if (c.value === null || c.value.trim() === "" || !Number.isFinite(want)) return { result: "unknown", note: "the requirement has no number" };
      const got = factNumber(f);
      if (!got) return { result: "unknown", note: "the listing gives no number" };
      const v = inRequirementUnit(c, got, `${f.value ?? ""} ${f.unit ?? ""}`);
      if ("why" in v) return { result: "unknown", note: v.why };
      const ok = c.operator === "gte" ? v.value >= want - 1e-9 : v.value <= want + 1e-9;
      return { result: ok ? "met" : "not_met" };
    }
    case "eq": {
      const want = (c.value ?? "").trim();
      if (!want) return { result: "unknown", note: "the requirement has no value" };
      if (YES.test(want) || NO.test(want)) {
        const has = !ABSENT.test(factText);
        return { result: (YES.test(want) ? has : !has) ? "met" : "not_met" };
      }
      if (/\d/.test(want) && Number.isFinite(Number(want))) {
        const got = factNumber(f);
        if (!got) return { result: "unknown", note: "the listing gives no number" };
        const v = inRequirementUnit(c, got, `${f.value ?? ""} ${f.unit ?? ""}`);
        if ("why" in v) return { result: "unknown", note: v.why };
        return { result: Math.abs(v.value - Number(want)) < 1e-6 ? "met" : "not_met" };
      }
      const w = norm(want);
      const t = norm(factText);
      return { result: t === w || ` ${t} `.includes(` ${w} `) ? "met" : "not_met" };
    }
    case "contains": {
      const w = norm(c.value ?? "");
      if (!w) return { result: "unknown", note: "the requirement has no value" };
      return { result: norm(factText).includes(w) ? "met" : "not_met" };
    }
    case "excludes": {
      const t = norm(factText);
      const w = norm(c.value ?? "");
      if (!w) return { result: "unknown", note: "the requirement has no value" };
      if (!t.includes(w)) return { result: "met" };
      return { result: NEGATION.test(factText) ? "met" : "not_met" };
    }
    default:
      return { result: "unknown", note: "unsupported comparison" };
  }
}

/**
 * Combine catalog-field facts and facts read from the listing text. When both
 * sources state a requirement and disagree on whether it's met, that's a
 * conflict, kept with both quotes.
 */
export function resolveFacts(
  constraints: Constraint[],
  fromCatalog: Facts,
  fromText: Facts,
): { facts: Facts; conflicts: Record<string, Fact[]> } {
  const facts: Facts = {};
  const conflicts: Record<string, Fact[]> = {};
  for (const c of constraints) {
    const a = fromCatalog[c.id] ?? null;
    const b = fromText[c.id] ?? null;
    if (a && b) {
      const ra = compare(c, a).result;
      const rb = compare(c, b).result;
      if (ra !== rb && ra !== "unknown" && rb !== "unknown") conflicts[c.id] = [a, b];
      // Cautious merge: a source that can't be confirmed (unknown) or that fails always outranks one that passes.
      const rank = { not_met: 0, unknown: 1, met: 2 } as const;
      facts[c.id] = rank[rb] < rank[ra] ? b : a;
    } else {
      facts[c.id] = a ?? b;
    }
  }
  return { facts, conflicts };
}

const sourceName = (f: Fact) => (f.source === "catalog_field" ? "catalog field" : "listing text");
const factLabel = (f: Fact) =>
  [f.value, f.unit && !(f.value ?? "").toLowerCase().includes(f.unit.toLowerCase()) ? f.unit : null].filter(Boolean).join(" ") ||
  "Stated";

function requirementCheck(c: Constraint, f: Fact | null, conflict: Fact[] | undefined): Check {
  const expected = describeRequirement(c);
  const kind = c.mandatory ? "" : " (nice to have)";
  const label = `${c.label}${kind}`;

  if (conflict && conflict.length > 1) {
    const anyViolates = conflict.some((x) => compare(c, x).result === "not_met");
    const said = conflict.map((x) => `the ${sourceName(x)} says ${factLabel(x)}`).join(", but ");
    return {
      id: c.id,
      label,
      // The seller's own data says a must-have is broken: block. Otherwise it needs a human look.
      status: c.mandatory && anyViolates ? "block" : "flag",
      state: "conflicting",
      detail: `The listing contradicts itself: ${said}. PACT can't confirm this requirement is met.`,
      expected,
      actual: conflict.map(factLabel).join(" vs "),
      evidence: conflict.map((x) => x.quote).join(" | "),
    };
  }

  if (!f) {
    return c.mandatory
      ? {
          id: c.id,
          label: c.label,
          status: "flag",
          state: "missing",
          detail: "The listing doesn't say. PACT won't guess, so you decide whether that's OK.",
          expected,
          actual: "Not stated",
        }
      : {
          id: c.id,
          label,
          status: "pass",
          state: "missing",
          detail: "Not stated in the listing. It's a nice-to-have, so it doesn't affect the verdict.",
          expected,
          actual: "Not stated",
        };
  }
  const { result, note } = compare(c, f);
  const actual = factLabel(f);
  if (result === "met") {
    return {
      id: c.id,
      label,
      status: "pass",
      state: "verified",
      detail: `Matches what you asked for (from the ${sourceName(f)}).`,
      expected,
      actual,
      evidence: f.quote,
    };
  }
  if (result === "unknown") {
    return {
      id: c.id,
      label,
      status: "flag",
      state: "unknown",
      detail: `The listing mentions it, but PACT can't compare it reliably (${note}).`,
      expected,
      actual,
      evidence: f.quote,
    };
  }
  return {
    id: c.id,
    label,
    status: c.mandatory ? "block" : "flag",
    state: "violated",
    detail: c.mandatory
      ? `The listing says ${actual}, which doesn't meet your requirement.`
      : `The listing says ${actual}. It's only a nice-to-have, so it needs your OK rather than blocking.`,
    expected,
    actual,
    evidence: f.quote,
  };
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { requirements: req, product, facts, conflicts = {}, injection, searchedPrice, agentClaims, agentSummary } = input;
  const checks: Check[] = [];
  const offer = product.offer;

  // 1. Text aimed at AI agents.
  if (injection.severity === "high") {
    checks.push({
      id: "injection",
      label: "Hidden instructions",
      status: "block",
      detail:
        "This listing contains text telling AI agents what to do. PACT never takes orders from a seller's page, so this listing is blocked.",
      actual: `${injection.findings.length} found`,
      evidence: injection.findings[0]?.excerpt,
    });
  } else if (injection.severity === "medium") {
    checks.push({
      id: "injection",
      label: "Hidden instructions",
      status: "flag",
      detail: "This listing has text that buyers can't see. Worth a closer look.",
      evidence: injection.findings[0]?.excerpt,
    });
  } else {
    checks.push({ id: "injection", label: "Hidden instructions", status: "pass", detail: "No text aimed at AI agents." });
  }

  // 2. Availability.
  if (offer.availability === "OutOfStock") {
    checks.push({ id: "availability", label: "Availability", status: "block", detail: "Out of stock.", actual: "Out of stock" });
  } else if (offer.availability === "Unknown") {
    checks.push({ id: "availability", label: "Availability", status: "flag", detail: "The catalog doesn't say whether it's in stock." });
  } else {
    checks.push({ id: "availability", label: "Availability", status: "pass", detail: "In stock according to the catalog." });
  }

  // 3. Currency and item price vs budget. Shipping, tax and checkout totals are NOT verified.
  const totalCents = toCents(offer.price);
  if (req.budget) {
    if (offer.currency !== req.budget.currency) {
      checks.push({
        id: "currency",
        label: "Currency",
        status: "block",
        detail: `Priced in ${offer.currency}, but your budget is in ${req.budget.currency}.`,
        expected: req.budget.currency,
        actual: offer.currency,
      });
    } else {
      const over = totalCents > toCents(req.budget.max);
      checks.push({
        id: "budget",
        label: "Item price",
        status: over ? "block" : "pass",
        detail: over
          ? "The item price is over your budget."
          : "The item price is within your budget. Shipping and tax are not included or verified.",
        expected: `≤ ${formatMoney(req.budget.max, req.budget.currency)}`,
        actual: formatMoney(offer.price, offer.currency),
      });
    }
  } else {
    checks.push({ id: "budget", label: "Item price", status: "flag", detail: "You haven't set a budget." });
  }

  // 4. Price changed between search and now.
  if (searchedPrice !== undefined && toCents(offer.price) > toCents(searchedPrice)) {
    checks.push({
      id: "price-drift",
      label: "Price changed",
      status: "flag",
      detail: "The price went up after the product was found.",
      expected: formatMoney(searchedPrice, offer.currency),
      actual: formatMoney(offer.price, offer.currency),
    });
  }

  // 5. Each requirement.
  for (const c of req.constraints) checks.push(requirementCheck(c, facts[c.id] ?? null, conflicts[c.id]));

  // 6. Did the agent describe the product truthfully?
  if (agentClaims) {
    const mismatches: string[] = [];
    for (const claim of agentClaims) {
      const c = req.constraints.find((x) => x.id === claim.constraintId);
      if (!c || !claim.value) continue;
      const f = facts[c.id];
      if (!f) {
        mismatches.push(`said ${c.label.toLowerCase()} is ${claim.value}, the listing doesn't say`);
        continue;
      }
      const asFact: Fact = { ...f, value: claim.value, unit: f.unit };
      const claimed = compare({ ...c, operator: "eq", value: f.value ?? f.quote, unit: f.unit }, asFact);
      if (claimed.result === "not_met") mismatches.push(`said ${c.label.toLowerCase()} is ${claim.value}, the listing says ${f.value ?? f.quote}`);
    }
    checks.push({
      id: "agent-claim",
      label: "What the agent told you",
      status: mismatches.length ? "flag" : "pass",
      detail: mismatches.length
        ? `The agent's description doesn't match the listing: ${mismatches.join("; ")}.`
        : "The agent's description matches the listing.",
      evidence: agentSummary,
    });
  }

  return { verdict: VERDICT[worst(checks.map((c) => c.status))], checks, totalCents };
}
