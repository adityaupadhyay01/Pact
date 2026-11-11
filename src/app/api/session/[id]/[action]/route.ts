import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/http";
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

export async function POST(req: NextRequest, ctx: RouteContext<"/api/session/[id]/[action]">) {
  const { id, action } = await ctx.params;
  return handle(async () => {
    const b = await body<Record<string, unknown>>(req);
    switch (action) {
      case "approve":
        return approveContract(id, String(b.contractHash ?? ""));
      case "revise":
        return revise(id, (b.patch ?? {}) as Parameters<typeof revise>[1]);
      // The check runs as three steps so the UI can show progress and retry one step.
      case "discover":
        return discover(id);
      case "select":
        return select(id);
      case "verify":
        return verify(id);
      case "purchase":
        return approvePurchase(
          id,
          String(b.productId ?? b.listingId ?? ""),
          Array.isArray(b.acknowledgedFlags) ? b.acknowledgedFlags.map(String) : [],
        );
      case "order":
        return createPaypalOrder(id);
      case "sim-approve":
        return simulateApproval(id, String(b.orderId ?? ""), { decline: b.decline === true });
      case "cancel":
        return cancelPayment(id, String(b.orderId ?? ""));
      case "capture":
        return capture(id, String(b.orderId ?? ""));
      default:
        throw new PactError(404, "Unknown action");
    }
  });
}
