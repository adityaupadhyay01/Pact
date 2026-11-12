import type { Requirements } from "./contract";
import type { ProductRecord } from "./catalog/types";
import { catalogFacts, groundFacts, snapshot, type AgentClaim, type EvidenceSnapshot, type Fact, type Facts, type RawExtraction } from "./facts";
import { detectInjectionInText, type InjectionReport } from "./injection";
import { evaluate, resolveFacts, type Evaluation } from "./rules";

/**
 * The PACT Inspector, as a pure function.
 *
 * Input: the buyer's requirements, the product record exactly as retrieved, and
 * an untrusted extraction of that record's text (from Gemini or the test reader).
 * The shopping agent's words are only compared against the result, never used
 * as evidence. Every fact must quote the evidence snapshot word for word.
 */
export interface Inspection {
  evidence: EvidenceSnapshot;
  facts: Facts;
  conflicts: Record<string, Fact[]>;
  rejected: { constraintId: string; quote: string }[];
  injection: InjectionReport;
  evaluation: Evaluation;
}

/** What shoppers can see on the page (hidden text is checked separately). */
export const visibleText = (p: ProductRecord) =>
  [p.title, p.description ?? "", ...p.keyFeatures, ...Object.entries(p.attributes).map(([k, v]) => `${k}: ${v.join(", ")}`)].join("\n");

export function inspect(input: {
  requirements: Requirements;
  record: ProductRecord;
  extraction: RawExtraction | null;
  searchedPrice?: number;
  agent?: { claims: AgentClaim[]; summary: string } | null;
}): Inspection {
  const { requirements: req, record, extraction, searchedPrice, agent } = input;
  const evidence = snapshot(record);
  const fromCatalog = catalogFacts(req.constraints, record);
  const grounded = extraction
    ? groundFacts(extraction, req.constraints, evidence.text)
    : { facts: {} as Facts, rejected: [], instruction: null };
  const { facts, conflicts } = resolveFacts(req.constraints, fromCatalog, grounded.facts);
  for (const c of req.constraints) if (!(c.id in facts)) facts[c.id] = null;

  const injection = detectInjectionInText(visibleText(record), record.hiddenText, grounded.instruction);
  const evaluation = evaluate({
    requirements: req,
    product: record,
    facts,
    conflicts,
    injection,
    searchedPrice,
    agentClaims: agent?.claims,
    agentSummary: agent?.summary,
  });
  return { evidence, facts, conflicts, rejected: grounded.rejected, injection, evaluation };
}
