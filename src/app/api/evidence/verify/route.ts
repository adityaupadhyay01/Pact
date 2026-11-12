import { body, handle } from "@/lib/http";
import { PactError, verifyReceiptPackage } from "@/lib/pact";
import type { EvidenceEvent } from "@/lib/evidence";

const MAX_EVENTS = 500;

/**
 * Verify any receipt, e.g. one downloaded and edited by a judge.
 * Accepts the downloaded JSON as-is: { sessionId, events, receipt: { signature } }.
 */
export async function POST(req: Request) {
  return handle(async () => {
    // Receipts are larger than other requests, but still bounded.
    const b = await body<{ sessionId?: string; events?: EvidenceEvent[]; receipt?: { signature?: string }; signature?: string }>(req, 2 * 1024 * 1024);
    if (!Array.isArray(b.events) || typeof b.sessionId !== "string") {
      throw new PactError(400, "Expected { sessionId, events, receipt: { signature } }");
    }
    if (b.events.length > MAX_EVENTS) throw new PactError(413, "Too many events");
    return verifyReceiptPackage(b.sessionId, b.events, String(b.receipt?.signature ?? b.signature ?? ""));
  });
}
