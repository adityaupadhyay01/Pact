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
}

export interface EvaluationInput {
  requirements: Requirements;
  product: ProductRecord;
  facts: Facts;
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
const YES = /^(yes|true|included|present|available)$/i;
const NO = /^(no|false|not included|none|unavailable)$/i;
const NEGATION = /\b(free|no|without|does not contain|doesn't contain|non)\b/i;

/**
 * Compare one requirement with one fact.
 * "unknown" means the fact can't be compared (units don't match, no number).
 */
export function compare(c: Constraint, f: Fact): { result: "met" | "not_met" | "unknown"; note?: string } {
  const factText = f.value ?? f.quote;
  switch (c.operator) {
    case "present":
      return { result: "met" };
    case "gte":
    case "lte": {
      const req = parseNumber(`${c.value ?? ""} ${c.unit ?? ""}`);
      const got = parseNumber(f.unit ? `${f.value ?? ""} ${f.unit}` : factText);
      if (!req || !got) return { result: "unknown", note: "no number to compare" };
      const reqUnit = normalizeUnit(c.unit) ?? req.unit;
      const gotUnit = normalizeUnit(f.unit) ?? got.unit;
      let value = got.value;
      let note: string | undefined;
      if (reqUnit && gotUnit && reqUnit !== gotUnit) {
        const converted = convert(got.value, gotUnit, reqUnit);
        if (converted === null) return { result: "unknown", note: `can't compare ${gotUnit} with ${reqUnit}` };
        value = converted;
      } else if (!reqUnit !== !gotUnit) {
        note = "assumed the same unit";
      }
      const ok = c.operator === "gte" ? value >= req.value - 1e-9 : value <= req.value + 1e-9;
      return { result: ok ? "met" : "not_met", note };
    }
    case "eq": {
      const want = (c.value ?? "").trim();
      if (YES.test(want) || NO.test(want)) {
        const has = !NO.test(factText.trim()) && !/\bnot\b/i.test(factText);
        return { result: (YES.test(want) ? has : !has) ? "met" : "not_met" };
      }
      const a = parseNumber(`${want} ${c.unit ?? ""}`);
      const b = parseNumber(f.unit ? `${f.value ?? ""} ${f.unit}` : factText);
      if (a && b && /\d/.test(want)) {
        const conv = convert(b.value, normalizeUnit(f.unit) ?? b.unit, normalizeUnit(c.unit) ?? a.unit);
        const v = conv ?? b.value;
        return { result: Math.abs(v - a.value) < 1e-6 ? "met" : "not_met" };
      }
      const w = norm(want);
      const t = norm(factText);
      return { result: t === w || ` ${t} `.includes(` ${w} `) ? "met" : "not_met" };
    }
    case "contains":
      return { result: norm(factText).includes(norm(c.value ?? "")) ? "met" : "not_met" };
    case "excludes": {
      const t = norm(factText);
      const w = norm(c.value ?? "");
      if (!t.includes(w)) return { result: "met" };
      return { result: NEGATION.test(factText) ? "met" : "not_met" };
    }
  }
}

function requirementCheck(c: Constraint, f: Fact | null): Check {
  const expected = describeRequirement(c);
  const kind = c.mandatory ? "" : " (nice to have)";
  if (!f) {
    return c.mandatory
      ? {
          id: c.id,
          label: c.label,
          status: "flag",
          detail: "The listing doesn't say. PACT won't guess, so you decide whether that's OK.",
          expected,
          actual: "Not stated",
        }
      : {
          id: c.id,
          label: `${c.label}${kind}`,
          status: "pass",
          detail: "Not stated in the listing. It's a nice-to-have, so it doesn't affect the verdict.",
          expected,
          actual: "Not stated",
        };
  }
  const { result, note } = compare(c, f);
  const actual = [f.value, f.unit && !(f.value ?? "").includes(f.unit) ? f.unit : null].filter(Boolean).join(" ") || "Stated";
  const source = f.source === "catalog_field" ? "catalog field" : "listing text";
  if (result === "met") {
    return {
      id: c.id,
      label: `${c.label}${kind}`,
      status: "pass",
      detail: `Matches what you asked for (from the ${source}${note ? `; ${note}` : ""}).`,
      expected,
      actual,
      evidence: f.quote,
    };
  }
  if (result === "unknown") {
    return {
      id: c.id,
      label: `${c.label}${kind}`,
      status: "flag",
      detail: `The listing mentions it, but PACT can't compare it reliably (${note}).`,
      expected,
      actual,
      evidence: f.quote,
    };
  }
  return {
    id: c.id,
    label: `${c.label}${kind}`,
    status: c.mandatory ? "block" : "flag",
    detail: c.mandatory
      ? `The listing says ${actual}, which doesn't meet your requirement.`
      : `The listing says ${actual}. It's only a nice-to-have, so it needs your OK rather than blocking.`,
    expected,
    actual,
    evidence: f.quote,
  };
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { requirements: req, product, facts, injection, searchedPrice, agentClaims, agentSummary } = input;
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
  for (const c of req.constraints) checks.push(requirementCheck(c, facts[c.id] ?? null));

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
