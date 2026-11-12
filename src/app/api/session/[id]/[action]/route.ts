import type { NextRequest } from "next/server";
import { body, handle, orderId, productId, sessionId } from "@/lib/http";
import {
  approveContract,
  approvePurchase,
  cancelPayment,
  capture,
  createPaypalOrder,
  discover,
  PactError,
  revise,
  select,
  simulateApproval,
  verify,
} from "@/lib/pact";

export const maxDuration = 60;

const ACTIONS = new Set(["approve", "revise", "discover", "select", "verify", "purchase", "order", "sim-approve", "cancel", "capture"]);

export async function POST(req: NextRequest, ctx: RouteContext<"/api/session/[id]/[action]">) {
  const { id: rawId, action } = await ctx.params;
  return handle(async () => {
    if (!ACTIONS.has(action)) throw new PactError(404, "Unknown action", "NOT_FOUND");
    const id = sessionId(rawId);
    const b = await body<Record<string, unknown>>(req);
    switch (action) {
      case "approve":
        return approveContract(id, String(b.contractHash ?? ""));
      case "revise": {
        const patch = b.patch && typeof b.patch === "object" ? (b.patch as Parameters<typeof revise>[1]) : {};
        return revise(id, patch);
      }
      // The check runs as three steps so the UI can show progress and retry one step.
      case "discover":
        return discover(id);
      case "select":
        return select(id);
      case "verify":
        return verify(id);
      case "purchase": {
        // The price the buyer saw is only compared with the fresh price; it's never used as the price.
        const expectedPrice = typeof b.expectedPrice === "number" && Number.isFinite(b.expectedPrice) ? b.expectedPrice : undefined;
        const expectedCurrency = typeof b.expectedCurrency === "string" ? b.expectedCurrency.slice(0, 3).toUpperCase() : undefined;
        const acks = Array.isArray(b.acknowledgedFlags) ? b.acknowledgedFlags.slice(0, 50).map((x) => String(x).slice(0, 40)) : [];
        return approvePurchase(id, productId(b.productId ?? b.listingId), acks, { price: expectedPrice, currency: expectedCurrency });
      }
      case "order":
        return createPaypalOrder(id);
      case "sim-approve":
        return simulateApproval(id, orderId(b.orderId), { decline: b.decline === true });
      case "cancel":
        return cancelPayment(id, orderId(b.orderId));
      case "capture":
        return capture(id, orderId(b.orderId));
      default:
        throw new PactError(404, "Unknown action", "NOT_FOUND");
    }
  });
}
