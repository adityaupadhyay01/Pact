import { formatMoney } from "@/lib/money";
import type { Requirements } from "@/lib/contract";
import type { ProductRecord } from "@/lib/catalog/types";
import type { Verified } from "@/lib/store";
import { describeRequirement } from "@/lib/rules";
import type { SessionView } from "./api";

export type { Verified };

export interface Analysis {
  /** What the shopping agent chose and said. */
  agent: { record: ProductRecord; reasons: string[]; summary: string; engine: "gemini" | "test" } | null;
  /** PACT's verification of the agent's pick. */
  subject: Verified | null;
  /** PACT's best verified match when the pick isn't a clean pass. */
  alternative: Verified | null;
  /** Every product PACT verified, pick first. */
  checked: Verified[];
  /** Products found but not verified (e.g. AI rate limit). */
  unchecked: ProductRecord[];
  candidateCount: number;
}

export function analyse(s: SessionView): Analysis {
  const d = s.discovery;
  const a = s.agent;
  const v = s.verification;
  const record = a && d ? (d.candidates.find((c) => c.id === a.chosenId) ?? null) : null;
  const checked = v ? [v.subject, ...v.alternatives] : [];
  const checkedIds = new Set(checked.map((x) => x.productId));
  return {
    agent: a && record ? { record, reasons: a.reasons, summary: a.summary, engine: a.engine } : null,
    subject: v?.subject ?? null,
    alternative: v?.recommendedId ? (v.alternatives.find((x) => x.productId === v.recommendedId) ?? null) : null,
    checked,
    unchecked: d && v ? d.candidates.filter((c) => !checkedIds.has(c.id) && v.unchecked.includes(c.id)) : [],
    candidateCount: d?.candidates.length ?? 0,
  };
}

export const findVerified = (s: SessionView, id: string): Verified | null =>
  s.verification ? ([s.verification.subject, ...s.verification.alternatives].find((x) => x.productId === id) ?? null) : null;

/** The buyer's requirements as short phrases, e.g. ["cocoa content at least 70%", "item price up to $5.00"]. */
export function requirementTerms(r: Requirements): string[] {
  return [
    ...r.constraints.filter((c) => c.mandatory).map((c) => `${c.label.toLowerCase()} ${describeRequirement(c)}`),
    r.budget ? `item price up to ${formatMoney(r.budget.max, r.budget.currency)}` : "no budget yet",
  ];
}

export function joinLabels(labels: string[]): string {
  const l = labels.map((x) => x.toLowerCase());
  if (l.length <= 1) return l.join("");
  return `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

export const sourceLabel = (p: ProductRecord) =>
  p.synthetic?.kind === "seller-mode"
    ? "TEST: altered by Seller Mode"
    : p.provider === "test-store"
      ? "TEST STORE: fictional product"
      : "Channel3 catalog";
