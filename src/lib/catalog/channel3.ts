import "server-only";
import { CatalogError, type ProductRecord, type SearchRequest } from "./types";
import { normalise, type C3Product } from "./channel3-normalise";

/**
 * Channel3 product catalog (https://channel3.ai/docs).
 *
 * - POST /v1/search (1 credit), GET /v1/products/{id} (free; used to refresh price
 *   and availability before approval, as the caching guide recommends).
 * - The API key stays on the server (`x-api-key`). End users never see it.
 * - Offer URLs are not kept: they are short-lived, and PACT shows only the domain.
 * - Nothing here is cached across sessions (Terms §7: no storing a significant
 *   portion of Customer Output; caching guide: refresh prices before display).
 */

const BASE = process.env.CHANNEL3_API_BASE || "https://api.trychannel3.com";
const TIMEOUT_MS = 15_000;

export const channel3Configured = () => Boolean(process.env.CHANNEL3_API_KEY);

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new CatalogError("unconfigured", "Channel3 isn't configured on this server.");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "x-api-key": key, "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    throw new CatalogError(timeout ? "timeout" : "upstream", timeout ? "Channel3 took too long to respond." : "Couldn't reach Channel3.");
  }
  if (res.ok) return (await res.json()) as T;
  const kind =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 402
        ? "credits"
        : res.status === 429
          ? "rate_limited"
          : res.status === 404
            ? "not_found"
            : res.status === 400 || res.status === 422
              ? "bad_request"
              : "upstream";
  const messages: Record<string, string> = {
    auth: "Channel3 rejected the API key.",
    credits: "Channel3 credits are used up for this month.",
    rate_limited: "Channel3 is rate-limiting requests. Try again in a few seconds.",
    not_found: "Channel3 couldn't find that product anymore.",
    bad_request: "Channel3 couldn't run this search.",
    upstream: `Channel3 returned an error (${res.status}).`,
  };
  throw new CatalogError(kind as CatalogError["kind"], messages[kind]);
}

export async function searchChannel3(req: SearchRequest): Promise<ProductRecord[]> {
  const body = {
    query: req.query,
    limit: Math.min(Math.max(req.limit, 1), 30),
    filters: {
      ...(req.maxPrice ? { price: { max_price: req.maxPrice } } : {}),
      conditions: req.conditions,
      availability: ["InStock"],
    },
    config: { currency: req.currency, country: "US", mode: "default" },
  };
  const res = await call<{ products?: C3Product[] }>("/v1/search", { method: "POST", body: JSON.stringify(body) });
  const now = new Date();
  return (res.products ?? []).map((p) => normalise(p, now)).filter((p): p is ProductRecord => p !== null);
}

/** Fresh product data (free endpoint). Used before verification and approval. */
export async function productChannel3(id: string, currency: string): Promise<ProductRecord | null> {
  const p = await call<C3Product>(`/v1/products/${encodeURIComponent(id)}?currency=${encodeURIComponent(currency)}&country=US`, {
    method: "GET",
  });
  return normalise(p);
}
