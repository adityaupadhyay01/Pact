import { body, handle } from "@/lib/http";
import { startSession } from "@/lib/pact";
import { SELLER_ATTACKS, type SellerAttack } from "@/lib/seller-mode";

/** Start a check: read the request into requirements. */
export async function POST(req: Request) {
  return handle(async () => {
    const b = await body<{ text?: string; mode?: string; sellerAttack?: string | null }>(req);
    const mode = b.mode === "test" ? "test" : "live";
    const sellerAttack = SELLER_ATTACKS.includes(b.sellerAttack as SellerAttack) ? (b.sellerAttack as SellerAttack) : null;
    // Coarse visitor key for rate limiting only; it is hashed before use and never stored raw.
    // On Vercel, x-real-ip is set by the platform; a client-supplied x-forwarded-for is only a fallback.
    const client = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "local").trim().slice(0, 64);
    return startSession(String(b.text ?? ""), { mode, sellerAttack, client });
  });
}
