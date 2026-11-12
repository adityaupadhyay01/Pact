import "server-only";
import { randomBytes } from "node:crypto";
import { signReceipt, verifyReceipt, type EvidenceEvent } from "./evidence";
import { ConfigError, isProduction } from "./env";

/**
 * Receipt signing key. Set EVIDENCE_SECRET in any hosted deployment: without it
 * a random key is generated per server process, so signatures stop verifying
 * after a restart or on another serverless instance.
 */
const g = globalThis as unknown as { __pactEphemeralSecret?: string };
function secret(): string {
  if (process.env.EVIDENCE_SECRET) return process.env.EVIDENCE_SECRET;
  // A per-process key would make hosted receipts unverifiable after a restart: refuse instead.
  if (isProduction()) throw new ConfigError("EVIDENCE_SECRET is required in production, so receipts stay verifiable.");
  g.__pactEphemeralSecret ??= randomBytes(32).toString("hex");
  return g.__pactEphemeralSecret;
}

export const receiptKeyMode = (): "configured" | "ephemeral" => (process.env.EVIDENCE_SECRET ? "configured" : "ephemeral");

export const sign = (sessionId: string, events: readonly EvidenceEvent[]) => signReceipt(secret(), sessionId, events);

export const verify = (sessionId: string, events: readonly EvidenceEvent[], signature: string) =>
  verifyReceipt(secret(), sessionId, events, signature);
