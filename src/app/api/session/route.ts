import { body, handle } from "@/lib/http";
import { startSession } from "@/lib/pact";
import { SELLER_ATTACKS, type SellerAttack } from "@/lib/seller-mode";

/** Start a check: read the request into requirements. */
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ text?: string; mode?: string; sellerAttack?: string | null }>(req);
    const mode = b.mode === "test" ? "test" : "live";
    const sellerAttack = SELLER_ATTACKS.includes(b.sellerAttack as SellerAttack) ? (b.sellerAttack as SellerAttack) : null;
    // Coarse per-client key for rate limiting. Not used for anything else.
    const client = (req.headers.get("x-forwarded-for")?.split(",")[0] || req.headers.get("x-real-ip") || "local").trim();
    return startSession(String(b.text ?? ""), { mode, sellerAttack, client });
  });
}
