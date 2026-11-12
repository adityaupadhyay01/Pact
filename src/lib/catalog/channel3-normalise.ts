import type { ProductRecord } from "./types";

/** Maps Channel3 product responses (documented Product schema) to PACT records. Pure, so it can be unit tested. */

// ---- Response shapes (subset of the documented Product schema) ----
export interface C3Offer {
  url?: string;
  domain?: string;
  price?: { price?: number; compare_at_price?: number | null; currency?: string };
  availability?: "InStock" | "OutOfStock" | string;
  condition?: "new" | "used" | null;
}
export interface C3Product {
  id: string;
  title: string;
  description?: string | null;
  brands?: { id?: string; name?: string }[] | null;
  images?: { url?: string; is_main_image?: boolean }[] | null;
  category?: { title?: string; path?: { title?: string }[] } | null;
  materials?: string[] | null;
  key_features?: string[] | null;
  offers?: C3Offer[] | null;
  structured_attributes?: Record<string, string[]> | null;
}


const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : []);

/** The merchant's host name, only if Channel3 gave one. PACT never invents a seller. */
function hostOf(o: C3Offer): string | null {
  const d = str(o.domain);
  if (d) return d.toLowerCase();
  try {
    return o.url ? new URL(o.url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Offers PACT can verify: a positive price, a currency and a known merchant. */
function usable(o: C3Offer): boolean {
  const price = o?.price?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 && Boolean(str(o.price?.currency)) && hostOf(o) !== null;
}

/** Choose the offer PACT will verify: the cheapest usable in-stock offer, else the cheapest usable one. */
function pickOffer(offers: C3Offer[]): C3Offer | null {
  const priced = offers.filter((o) => o && typeof o === "object" && usable(o));
  const inStock = priced.filter((o) => o.availability === "InStock");
  const pool = inStock.length ? inStock : priced;
  return [...pool].sort((a, b) => a.price!.price! - b.price!.price!)[0] ?? null;
}

/**
 * Normalise one Channel3 product. Returns null when the product can't be
 * verified honestly (no id, no title, or no offer with a price, currency and
 * merchant). Missing optional fields stay empty: nothing is filled in.
 */
export function normalise(p: C3Product, now = new Date()): ProductRecord | null {
  if (!p || typeof p !== "object") return null;
  const id = str(p.id);
  const title = str(p.title);
  const offer = pickOffer(Array.isArray(p.offers) ? p.offers : []);
  if (!id || !title || !offer) return null;
  const availability = offer.availability === "InStock" || offer.availability === "OutOfStock" ? offer.availability : "Unknown";
  const images = Array.isArray(p.images) ? p.images : [];
  const image = images.find((i) => i?.is_main_image) ?? images[0];
  const path = Array.isArray(p.category?.path) ? p.category.path.map((x) => str(x?.title)).filter(Boolean) : [];
  const category = path.length ? path.join(" › ") : str(p.category?.title);
  const attrs = p.structured_attributes && typeof p.structured_attributes === "object" ? p.structured_attributes : {};
  return {
    id,
    provider: "channel3",
    title,
    brands: (Array.isArray(p.brands) ? p.brands : []).map((b) => str(b?.name)).filter((x): x is string => x !== null),
    description: str(p.description),
    keyFeatures: strings(p.key_features).slice(0, 12),
    attributes: Object.fromEntries(
      Object.entries(attrs)
        .map(([k, v]) => [k, strings(v)] as const)
        .filter(([, v]) => v.length),
    ),
    materials: strings(p.materials),
    category,
    offer: {
      domain: hostOf(offer)!,
      price: offer.price!.price!,
      currency: str(offer.price!.currency)!.toUpperCase(),
      availability,
      condition: offer.condition === "new" || offer.condition === "used" ? offer.condition : null,
    },
    imageUrl: str(image?.url),
    retrievedAt: now.toISOString(),
    hiddenText: [],
    synthetic: null,
  };
}
