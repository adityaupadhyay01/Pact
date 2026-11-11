import { z } from "zod";
import { deepFreeze, hashObject } from "./canonical";

/** What the buyer asked for, in machine-readable form. */
export const RequirementsSchema = z.object({
  category: z.literal("laptop"),
  ramGbMin: z.number().int().positive().nullable(),
  storageGbMin: z.number().int().positive().nullable(),
  warrantyMonthsMin: z.number().int().nonnegative().nullable(),
  condition: z.enum(["new", "any"]),
  maxTotal: z.number().positive(),
  currency: z.string().length(3),
  /** Nice-to-haves. Changing these does not require re-approval. */
  preferences: z.array(z.string()),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** Changing any of these invalidates the buyer's approval. */
export const CRITICAL_FIELDS = [
  "category",
  "ramGbMin",
  "storageGbMin",
  "warrantyMonthsMin",
  "condition",
  "maxTotal",
  "currency",
] as const satisfies readonly (keyof Requirements)[];

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
  return seal({
    version: 1,
    requirements: parsed,
    sourceText,
    createdAt: now.toISOString(),
    parentHash: null,
  });
}

export function criticalDiff(a: Requirements, b: Requirements): string[] {
  return CRITICAL_FIELDS.filter((f) => a[f] !== b[f]);
}

/**
 * Contracts are never edited in place. A revision produces a new sealed version
 * linked to its parent, and reports which critical fields changed.
 */
export function reviseContract(
  prev: ContractVersion,
  patch: Partial<Requirements>,
  now: Date = new Date(),
): { contract: ContractVersion; criticalChanges: string[] } {
  const requirements = RequirementsSchema.parse({ ...prev.requirements, ...patch });
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

export function approve(
  contract: ContractVersion,
  approvedBy: string,
  now: Date = new Date(),
): Approval {
  return deepFreeze({
    contractHash: contract.hash,
    version: contract.version,
    approvedAt: now.toISOString(),
    approvedBy,
  });
}

/** An approval only counts if it was given for this exact contract hash. */
export function findValidApproval(
  contract: ContractVersion,
  approvals: readonly Approval[],
): Approval | null {
  if (!verifyContractHash(contract)) return null;
  return approvals.find((a) => a.contractHash === contract.hash) ?? null;
}
