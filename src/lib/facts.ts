import { z } from "zod";

/**
 * A fact the AI extracted from seller content. Every fact must carry the exact
 * text it came from, so the claim can be checked against the source.
 */
const fact = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, quote: z.string().min(1) }).nullable();

export const ConditionSchema = z.enum(["new", "refurbished", "used", "open-box"]);
export type Condition = z.infer<typeof ConditionSchema>;

export const ListingFactsSchema = z.object({
  ramGb: fact(z.number().int().positive()),
  storageGb: fact(z.number().int().positive()),
  warrantyMonths: fact(z.number().int().nonnegative()),
  condition: fact(ConditionSchema),
});
export type ListingFacts = z.infer<typeof ListingFactsSchema>;
export type FactKey = keyof ListingFacts;
export const FACT_KEYS: FactKey[] = ["ramGb", "storageGb", "warrantyMonths", "condition"];

export const emptyFacts = (): ListingFacts => ({
  ramGb: null,
  storageGb: null,
  warrantyMonths: null,
  condition: null,
});

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Grounding check: a fact whose quote does not literally appear in the source
 * text is discarded. This stops the model from inventing specs.
 */
export function groundFacts(
  facts: ListingFacts,
  sourceText: string,
): { facts: ListingFacts; rejected: { key: FactKey; quote: string }[] } {
  const haystack = norm(sourceText);
  const out = emptyFacts();
  const rejected: { key: FactKey; quote: string }[] = [];
  for (const key of FACT_KEYS) {
    const f = facts[key];
    if (!f) continue;
    if (haystack.includes(norm(f.quote))) {
      (out as Record<FactKey, unknown>)[key] = f;
    } else {
      rejected.push({ key, quote: f.quote });
    }
  }
  return { facts: out, rejected };
}

/** What an agent said about a product when recommending it. */
export interface AgentClaim {
  ramGb?: number;
  storageGb?: number;
  warrantyMonths?: number;
  condition?: Condition;
  total?: number;
  summary: string;
}
