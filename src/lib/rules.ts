import { formatMoney, toCents } from "./money";
import type { Requirements } from "./contract";
import type { AgentClaim, ListingFacts } from "./facts";
import type { InjectionReport } from "./injection";
import { feesTotal, quoteTotalCents, type CheckoutQuote } from "./quote";

/**
 * The deterministic decision layer. The LLM never decides PASS / FLAG / BLOCK:
 * it only supplies grounded facts. Every decision below is plain code.
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
  /** The seller text this check relied on. */
  evidence?: string;
}

export interface EvaluationInput {
  requirements: Requirements;
  facts: ListingFacts;
  listedPrice: number;
  quote: CheckoutQuote;
  injection: InjectionReport;
  agentClaim?: AgentClaim;
}

export interface Evaluation {
  verdict: Verdict;
  checks: Check[];
  totalCents: number;
}

const RANK: Record<Status, number> = { pass: 0, flag: 1, block: 2 };
const VERDICT: Record<Status, Verdict> = { pass: "PASS", flag: "FLAG", block: "BLOCK" };

export function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), "pass");
}

const CONDITION_LABEL = { new: "New", refurbished: "Refurbished", used: "Used", "open-box": "Open box" };
const fmtStorage = (gb: number) => (gb >= 1000 && gb % 1000 === 0 ? `${gb / 1000}TB` : `${gb}GB`);
const fmtWarranty = (m: number) =>
  m === 0 ? "No warranty" : m % 12 === 0 ? `${m / 12}-year` : `${m}-month`;

function minimumCheck(
  id: string,
  label: string,
  required: number | null,
  fact: { value: number; quote: string } | null,
  fmt: (n: number) => string,
): Check | null {
  if (required === null) return null;
  if (!fact) {
    return {
      id,
      label,
      status: "flag",
      detail: "The listing doesn't say. PACT won't guess, so check with the seller.",
      expected: `≥ ${fmt(required)}`,
      actual: "Not stated",
    };
  }
  const ok = fact.value >= required;
  return {
    id,
    label,
    status: ok ? "pass" : "block",
    detail: ok
      ? "Matches what you asked for."
      : `Only ${fmt(fact.value)}. You asked for at least ${fmt(required)}.`,
    expected: `≥ ${fmt(required)}`,
    actual: fmt(fact.value),
    evidence: fact.quote,
  };
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { requirements: req, facts, quote, injection, listedPrice, agentClaim } = input;
  const checks: Check[] = [];
  const cur = req.currency;

  // 1. Prompt injection in seller content.
  if (injection.severity === "high") {
    checks.push({
      id: "injection",
      label: "Hidden instructions",
      status: "block",
      detail:
        "This page has hidden text telling AI agents what to do, like ignoring your budget. PACT never takes orders from a seller's page, so this listing is blocked.",
      actual: `${injection.findings.length} hidden instruction${injection.findings.length === 1 ? "" : "s"}`,
      evidence: injection.findings[0]?.excerpt,
    });
  } else if (injection.severity === "medium") {
    checks.push({
      id: "injection",
      label: "Hidden instructions",
      status: "flag",
      detail: "This page has text that buyers can't see. Worth a closer look.",
      actual: `${injection.findings.length} hidden instruction${injection.findings.length === 1 ? "" : "s"}`,
      evidence: injection.findings[0]?.excerpt,
    });
  } else {
    checks.push({
      id: "injection",
      label: "Hidden instructions",
      status: "pass",
      detail: "No hidden text aimed at AI agents.",
    });
  }

  // 2. Currency.
  if (quote.currency !== cur) {
    checks.push({
      id: "currency",
      label: "Currency",
      status: "block",
      detail: `You'd be charged in ${quote.currency} instead of ${cur}, which can add conversion fees.`,
      expected: cur,
      actual: quote.currency,
    });
  } else {
    checks.push({ id: "currency", label: "Currency", status: "pass", detail: `Charged in ${cur}.` });
  }

  // 3. Total commitment vs budget (all-in: item + shipping + tax + fees).
  const totalCents = quoteTotalCents(quote);
  const overBudget = totalCents > toCents(req.maxTotal);
  checks.push({
    id: "budget",
    label: "Total price",
    status: overBudget ? "block" : "pass",
    detail: overBudget
      ? "The total, with tax, shipping and fees, is over your budget."
      : "The total, with tax, shipping and fees, is within your budget.",
    expected: `≤ ${formatMoney(req.maxTotal, cur)}`,
    actual: formatMoney(totalCents / 100, quote.currency),
  });

  // 4–6. Spec minimums.
  const specChecks = [
    minimumCheck("ram", "RAM", req.ramGbMin, facts.ramGb, (n) => `${n}GB`),
    minimumCheck("storage", "Storage", req.storageGbMin, facts.storageGb, fmtStorage),
    minimumCheck("warranty", "Warranty", req.warrantyMonthsMin, facts.warrantyMonths, fmtWarranty),
  ];
  for (const c of specChecks) if (c) checks.push(c);

  // 7. Condition.
  if (req.condition === "new") {
    if (!facts.condition) {
      checks.push({
        id: "condition",
        label: "Condition",
        status: "flag",
        detail: "The listing doesn't say whether it's new.",
        expected: "New",
        actual: "Not stated",
      });
    } else {
      const ok = facts.condition.value === "new";
      checks.push({
        id: "condition",
        label: "Condition",
        status: ok ? "pass" : "block",
        detail: ok ? "Item is new." : `Item is ${CONDITION_LABEL[facts.condition.value].toLowerCase()}, not new.`,
        expected: "New",
        actual: CONDITION_LABEL[facts.condition.value],
        evidence: facts.condition.quote,
      });
    }
  }

  // 8. Price drift between listing and checkout.
  if (toCents(quote.itemPrice) > toCents(listedPrice)) {
    checks.push({
      id: "price-drift",
      label: "Price changed",
      status: "flag",
      detail: "The price went up between the listing and checkout.",
      expected: formatMoney(listedPrice, cur),
      actual: formatMoney(quote.itemPrice, quote.currency),
    });
  }

  // 9. Extra fees beyond shipping and tax.
  if (quote.fees.length > 0) {
    checks.push({
      id: "fees",
      label: "Extra fees",
      status: "flag",
      detail: `Checkout adds fees the listing didn't mention: ${quote.fees.map((f) => `${f.label} (${formatMoney(f.amount, quote.currency)})`).join(", ")}.`,
      actual: formatMoney(feesTotal(quote), quote.currency),
    });
  }

  // 10. Recurring commitments.
  if (quote.recurring) {
    checks.push({
      id: "recurring",
      label: "Subscription",
      status: "flag",
      detail: `Checkout signs you up for a recurring charge: ${quote.recurring}.`,
    });
  }

  // 11. Did the agent describe the product truthfully?
  if (agentClaim) {
    const mismatches: string[] = [];
    const cmp = <K extends "ramGb" | "storageGb" | "warrantyMonths" | "condition">(
      key: K,
      fmt: (v: NonNullable<AgentClaim[K]>) => string,
    ) => {
      const claimed = agentClaim[key];
      if (claimed === undefined) return;
      const actual = facts[key]?.value;
      if (actual === undefined) mismatches.push(`claimed ${fmt(claimed as never)}, listing does not say`);
      else if (actual !== claimed) mismatches.push(`claimed ${fmt(claimed as never)}, listing says ${fmt(actual as never)}`);
    };
    cmp("ramGb", (v) => `${v}GB RAM`);
    cmp("storageGb", (v) => `${fmtStorage(v as number)} storage`);
    cmp("warrantyMonths", (v) => `${fmtWarranty(v as number)} warranty`);
    cmp("condition", (v) => CONDITION_LABEL[v as keyof typeof CONDITION_LABEL].toLowerCase());
    if (agentClaim.total !== undefined && toCents(agentClaim.total) !== totalCents) {
      mismatches.push(
        `claimed total ${formatMoney(agentClaim.total, cur)}, checkout is ${formatMoney(totalCents / 100, quote.currency)}`,
      );
    }
    checks.push({
      id: "agent-claim",
      label: "What the agent told you",
      status: mismatches.length ? "flag" : "pass",
      detail: mismatches.length
        ? `The agent's description doesn't match the listing: ${mismatches.join("; ")}.`
        : "The agent described it accurately.",
      evidence: agentClaim.summary,
    });
  }

  return { verdict: VERDICT[worst(checks.map((c) => c.status))], checks, totalCents };
}
