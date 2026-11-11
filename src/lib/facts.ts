import { z } from "zod";
import { hashObject } from "./canonical";
import type { Constraint } from "./contract";
import { appearsIn } from "./intent";
import type { ProductRecord } from "./catalog/types";

/**
 * Evidence and facts.
 *
 * PACT never verifies against what an agent said. It builds an evidence text
 * from the catalog record itself, hashes it, and only accepts facts whose quote
 * appears word for word in that text.
 */

export interface EvidenceSnapshot {
  productId: string;
  provider: ProductRecord["provider"];
  retrievedAt: string;
  synthetic: ProductRecord["synthetic"];
  text: string;
  hash: string;
}

export function evidenceText(p: ProductRecord): string {
  const lines: string[] = [];
  lines.push(`TITLE: ${p.title}`);
  if (p.brands.length) lines.push(`BRAND: ${p.brands.join(", ")}`);
  if (p.category) lines.push(`CATEGORY: ${p.category}`);
  if (p.description) lines.push(`DESCRIPTION: ${p.description.replace(/\s+/g, " ").trim()}`);
  for (const f of p.keyFeatures) lines.push(`FEATURE: ${f.replace(/\s+/g, " ").trim()}`);
  for (const [k, v] of Object.entries(p.attributes)) if (v.length) lines.push(`ATTRIBUTE ${k}: ${v.join(", ")}`);
  if (p.materials.length) lines.push(`MATERIALS: ${p.materials.join(", ")}`);
  lines.push(`PRICE: ${p.offer.price.toFixed(2)} ${p.offer.currency}`);
  lines.push(`AVAILABILITY: ${p.offer.availability}`);
  if (p.offer.condition) lines.push(`CONDITION: ${p.offer.condition}`);
  lines.push(`SELLER: ${p.offer.domain}`);
  for (const h of p.hiddenText) lines.push(`HIDDEN TEXT (not shown to buyers): ${h.replace(/\s+/g, " ").trim()}`);
  return lines.join("\n");
}

export function snapshot(p: ProductRecord): EvidenceSnapshot {
  const text = evidenceText(p);
  const body = { productId: p.id, provider: p.provider, retrievedAt: p.retrievedAt, synthetic: p.synthetic, text };
  return { ...body, hash: hashObject(body) };
}

/** A fact about one requirement, as found in the evidence. */
export const FactSchema = z.object({
  constraintId: z.string(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  quote: z.string(),
  source: z.enum(["catalog_field", "extracted"]),
});
export type Fact = z.infer<typeof FactSchema>;
export type Facts = Record<string, Fact | null>;

/** Untrusted extractor output for one requirement. */
export const RawFactSchema = z.object({
  constraintId: z.string(),
  stated: z.boolean(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  quote: z.string().nullable(),
});
export const RawExtractionSchema = z.object({
  facts: z.array(RawFactSchema),
  instructionsToAI: z.object({ found: z.boolean(), quote: z.string().nullable() }),
});
export type RawExtraction = z.infer<typeof RawExtractionSchema>;

/**
 * Grounding: an extracted fact counts only if its quote is literally in the
 * evidence. Rejected claims are reported, never used.
 */
export function groundFacts(
  raw: RawExtraction,
  constraints: Constraint[],
  evidence: string,
): { facts: Facts; rejected: { constraintId: string; quote: string }[]; instruction: string | null } {
  const facts: Facts = {};
  const rejected: { constraintId: string; quote: string }[] = [];
  const ids = new Set(constraints.map((c) => c.id));
  for (const c of constraints) facts[c.id] = null;
  for (const f of raw.facts) {
    if (!ids.has(f.constraintId) || !f.stated) continue;
    if (!f.quote || !appearsIn(f.quote, evidence)) {
      if (f.quote) rejected.push({ constraintId: f.constraintId, quote: f.quote });
      continue;
    }
    facts[f.constraintId] = {
      constraintId: f.constraintId,
      value: f.value?.trim() || null,
      unit: f.unit?.trim() || null,
      quote: f.quote.trim(),
      source: "extracted",
    };
  }
  const q = raw.instructionsToAI;
  const instruction = q.found && q.quote && appearsIn(q.quote, evidence) ? q.quote.trim() : null;
  return { facts, rejected, instruction };
}

const singular = (s: string) => s.replace(/s$/, "");

/**
 * Facts PACT can read straight from structured catalog fields, with no AI:
 * condition, brand, and attributes whose key matches the requirement.
 * The quote is the exact evidence line, so it is grounded by construction.
 */
export function catalogFacts(constraints: Constraint[], p: ProductRecord): Facts {
  const out: Facts = {};
  for (const c of constraints) {
    const attr = c.attribute;
    if (attr === "condition" && p.offer.condition) {
      out[c.id] = { constraintId: c.id, value: p.offer.condition, unit: null, quote: `CONDITION: ${p.offer.condition}`, source: "catalog_field" };
      continue;
    }
    if (attr === "brand" && p.brands.length) {
      out[c.id] = { constraintId: c.id, value: p.brands.join(", "), unit: null, quote: `BRAND: ${p.brands.join(", ")}`, source: "catalog_field" };
      continue;
    }
    const key = Object.keys(p.attributes).find((k) => k === attr || singular(k) === singular(attr));
    if (key && p.attributes[key].length) {
      const v = p.attributes[key].join(", ");
      out[c.id] = { constraintId: c.id, value: v, unit: null, quote: `ATTRIBUTE ${key}: ${v}`, source: "catalog_field" };
    }
  }
  return out;
}

/** What an agent said about the product it chose, per requirement. */
export interface AgentClaim {
  constraintId: string;
  value: string | null;
}
