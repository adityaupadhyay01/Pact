import type { NextRequest } from "next/server";
import { body, handle } from "@/lib/http";
import {
  approveContract,
  approvePurchase,
  cancelPayment,
  capture,
  createPaypalOrder,
  PactError,
  revise,
  search,
  simulateApproval,
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
        return revise(id, (b.patch ?? {}) as Record<string, unknown>);
      case "search":
        return search(id);
      case "purchase":
        return approvePurchase(
          id,
          String(b.listingId ?? ""),
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
