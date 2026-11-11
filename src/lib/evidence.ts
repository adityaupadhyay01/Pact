import { createHmac, timingSafeEqual } from "node:crypto";
import { hashObject } from "./canonical";

/**
 * Append-only, hash-chained event log. Each event's hash covers its own content
 * and the previous event's hash, so editing, removing or reordering any event
 * breaks every hash after it.
 */

export type EventType =
  | "REQUEST_RECEIVED"
  | "CONTRACT_CREATED"
  | "CONTRACT_REVISED"
  | "CONTRACT_APPROVED"
  | "APPROVAL_INVALIDATED"
  | "AGENT_SEARCH"
  | "LISTING_EVALUATED"
  | "PURCHASE_APPROVED"
  | "PAYPAL_ORDER_CREATED"
  | "PAYPAL_ORDER_VERIFIED"
  | "PAYPAL_CAPTURE_BLOCKED"
  | "PAYPAL_CAPTURED"
  | "PAYPAL_CANCELLED"
  | "PAYPAL_PAYMENT_FAILED";

export interface EvidenceSource {
  kind: "buyer" | "listing" | "checkout" | "paypal" | "pact" | "agent";
  ref: string;
}

export interface EvidenceEvent {
  seq: number;
  timestamp: string;
  type: EventType;
  actor: "buyer" | "pact" | "agent" | "paypal";
  summary: string;
  data: unknown;
  sources: EvidenceSource[];
  prevHash: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);

type EventBody = Omit<EvidenceEvent, "hash">;

export function eventHash(body: EventBody): string {
  return hashObject(body);
}

export function appendEvent(
  chain: readonly EvidenceEvent[],
  e: Pick<EvidenceEvent, "type" | "actor" | "summary" | "data" | "sources">,
  now: Date = new Date(),
): EvidenceEvent[] {
  const prev = chain[chain.length - 1];
  const body: EventBody = {
    seq: chain.length,
    timestamp: now.toISOString(),
    type: e.type,
    actor: e.actor,
    summary: e.summary,
    data: e.data,
    sources: e.sources,
    prevHash: prev ? prev.hash : GENESIS,
  };
  return [...chain, { ...body, hash: eventHash(body) }];
}

export interface ChainVerification {
  valid: boolean;
  /** Index of the first event that fails verification. */
  brokenAt: number | null;
  reason: string | null;
  headHash: string;
}

export function verifyChain(chain: readonly EvidenceEvent[]): ChainVerification {
  let prevHash = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const { hash, ...body } = chain[i];
    if (body.seq !== i) return fail(i, `Event ${i} has sequence number ${body.seq}`, chain);
    if (body.prevHash !== prevHash) return fail(i, `Event ${i} does not link to the previous event`, chain);
    if (eventHash(body) !== hash) return fail(i, `Event ${i} content does not match its hash`, chain);
    prevHash = hash;
  }
  return { valid: true, brokenAt: null, reason: null, headHash: prevHash };
}

function fail(i: number, reason: string, chain: readonly EvidenceEvent[]): ChainVerification {
  return { valid: false, brokenAt: i, reason, headHash: chain[chain.length - 1]?.hash ?? GENESIS };
}

/**
 * Hash chains alone are not tamper-proof: anyone holding the file can edit an
 * event and recompute every hash. So the server signs the chain head with a
 * secret (HMAC-SHA256). A forged chain cannot carry a valid signature.
 */
export interface ReceiptVerification extends ChainVerification {
  signatureValid: boolean;
}

export function signReceipt(secret: string, sessionId: string, events: readonly EvidenceEvent[]): string {
  const head = events[events.length - 1]?.hash ?? GENESIS;
  return createHmac("sha256", secret).update(`pact-receipt.v1.${sessionId}.${events.length}.${head}`).digest("hex");
}

export function verifyReceipt(
  secret: string,
  sessionId: string,
  events: readonly EvidenceEvent[],
  signature: string,
): ReceiptVerification {
  const chain = verifyChain(events);
  if (!chain.valid) return { ...chain, signatureValid: false };
  const expected = Buffer.from(signReceipt(secret, sessionId, events), "hex");
  const given = Buffer.from(/^[0-9a-f]{64}$/i.test(signature) ? signature : "", "hex");
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  return ok
    ? { ...chain, signatureValid: true }
    : {
        ...chain,
        valid: false,
        signatureValid: false,
        reason: "The receipt's signature doesn't match: it was changed after PACT signed it",
      };
}
