import { z } from "zod";
import { deepFreeze, hashObject } from "./canonical";

/**
 * A category-agnostic purchase contract.
 *
 * Every requirement must come from the buyer's own words: each constraint and
 * the budget carry the quote they were taken from (or are marked as edited by
 * the buyer). Nothing is defaulted: no budget is invented, no spec is assumed.
 */

export const OperatorSchema = z.enum(["gte", "lte", "eq", "contains", "excludes", "present"]);
export type Operator = z.infer<typeof OperatorSchema>;

export const ConstraintSchema = z.object({
  id: z.string().regex(/^c\d{1,2}$/),
  /** Human label, e.g. "Cocoa content". */
  label: z.string().min(1).max(60),
  /** Machine key, e.g. "cocoa_percent". Used to match structured catalog attributes. */
  attribute: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/),
  operator: OperatorSchema,
  /** The required value as text ("70", "black"). Null only for "present". */
  value: z.string().max(80).nullable(),
  unit: z.string().max(20).nullable(),
  /** Mandatory constraints block; preferences never block. */
  mandatory: z.boolean(),
  /** Where it came from: the buyer's words, or a later edit by the buyer. */
  origin: z.enum(["request", "edited"]),
  /** The exact words in the request this was taken from (empty when edited). */
  userQuote: z.string().max(200),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export const BudgetSchema = z.object({
  max: z.number().positive().max(1_000_000),
  currency: z.string().length(3),
  /** PACT verifies the item price only. Shipping, tax and checkout totals are not verified. */
  scope: z.literal("item_price"),
  origin: z.enum(["request", "edited"]),
  userQuote: z.string().max(200),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const RequirementsSchema = z.object({
  /** What the buyer wants, in plain words: "dark chocolate bar". */
  product: z.string().min(2).max(120),
  /** Text used to search the catalog. */
  searchQuery: z.string().min(2).max(120),
  constraints: z.array(ConstraintSchema).max(10),
  /** Null until the buyer states a budget. Never defaulted. */
  budget: BudgetSchema.nullable(),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

export interface ContractVersion {
  readonly version: number;
  readonly requirements: Requirements;
  /** The buyer's original words, kept as the source reference. */
  readonly sourceText: string;
  readonly createdAt: string;
  readonly parentHash: string | null;
  /** SHA-256 over every field above. Approvals bind to this. */
  readonly hash: string;
}

export interface Approval {
  readonly contractHash: string;
  readonly version: number;
  readonly approvedAt: string;
  readonly approvedBy: string;
  /** Set when a non-critical revision carried an earlier approval forward. */
  readonly carriedFromHash?: string;
}

function seal(body: Omit<ContractVersion, "hash">): ContractVersion {
  return deepFreeze({ ...body, hash: hashObject(body) });
}

export function createContract(
  requirements: Requirements,
  sourceText: string,
  now: Date = new Date(),
): ContractVersion {
  const parsed = RequirementsSchema.parse(requirements);
  return seal({ version: 1, requirements: parsed, sourceText, createdAt: now.toISOString(), parentHash: null });
}

/** The parts of a contract whose change invalidates the buyer's approval. */
function criticalView(r: Requirements) {
  return {
    product: r.product,
    searchQuery: r.searchQuery,
    budget: r.budget ? { max: r.budget.max, currency: r.budget.currency } : null,
    mandatory: r.constraints
      .filter((c) => c.mandatory)
      .map((c) => ({ attribute: c.attribute, operator: c.operator, value: c.value, unit: c.unit })),
  };
}

export function criticalDiff(a: Requirements, b: Requirements): string[] {
  const x = criticalView(a);
  const y = criticalView(b);
  const changed: string[] = [];
  if (x.product !== y.product || x.searchQuery !== y.searchQuery) changed.push("product");
  if (hashObject(x.budget) !== hashObject(y.budget)) changed.push("budget");
  if (hashObject(x.mandatory) !== hashObject(y.mandatory)) changed.push("requirements");
  return changed;
}

/**
 * Contracts are never edited in place. A revision produces a new sealed version
 * linked to its parent, and reports which critical parts changed.
 */
export function reviseContract(
  prev: ContractVersion,
  next: Requirements,
  now: Date = new Date(),
): { contract: ContractVersion; criticalChanges: string[] } {
  const requirements = RequirementsSchema.parse(next);
  const contract = seal({
    version: prev.version + 1,
    requirements,
    sourceText: prev.sourceText,
    createdAt: now.toISOString(),
    parentHash: prev.hash,
  });
  return { contract, criticalChanges: criticalDiff(prev.requirements, requirements) };
}

export function verifyContractHash(c: ContractVersion): boolean {
  const { hash, ...body } = c;
  return hashObject(body) === hash;
}

export function approve(contract: ContractVersion, approvedBy: string, now: Date = new Date()): Approval {
  return deepFreeze({
    contractHash: contract.hash,
    version: contract.version,
    approvedAt: now.toISOString(),
    approvedBy,
  });
}

/** An approval only counts if it was given for this exact contract hash. */
export function findValidApproval(contract: ContractVersion, approvals: readonly Approval[]): Approval | null {
  if (!verifyContractHash(contract)) return null;
  return approvals.find((a) => a.contractHash === contract.hash) ?? null;
}

/** What still stops this contract from being approved. Empty means it is ready. */
export function missingForApproval(r: Requirements): ("budget" | "requirements")[] {
  const missing: ("budget" | "requirements")[] = [];
  if (!r.budget) missing.push("budget");
  return missing;
}
