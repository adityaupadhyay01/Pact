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


/** Choose the offer PACT will verify: the cheapest in-stock offer, else the first one. */
function pickOffer(offers: C3Offer[]): C3Offer | null {
  const priced = offers.filter((o) => typeof o.price?.price === "number" && o.price.currency);
  const inStock = priced.filter((o) => o.availability === "InStock");
  const pool = inStock.length ? inStock : priced;
  return pool.sort((a, b) => (a.price!.price! - b.price!.price!))[0] ?? null;
}

const hostOf = (o: C3Offer) => {
  if (o.domain) return o.domain;
  try {
    return o.url ? new URL(o.url).hostname : "unknown seller";
  } catch {
    return "unknown seller";
  }
};

export function normalise(p: C3Product, now = new Date()): ProductRecord | null {
  const offer = pickOffer(p.offers ?? []);
  if (!offer || !p.id || !p.title) return null;
  const availability = offer.availability === "InStock" || offer.availability === "OutOfStock" ? offer.availability : "Unknown";
  const image = (p.images ?? []).find((i) => i.is_main_image) ?? (p.images ?? [])[0];
  const category = p.category?.path?.length
    ? p.category.path.map((x) => x.title).filter(Boolean).join(" › ")
    : (p.category?.title ?? null);
  return {
    id: p.id,
    provider: "channel3",
    title: p.title,
    brands: (p.brands ?? []).map((b) => b.name ?? "").filter(Boolean),
    description: p.description ?? null,
    keyFeatures: (p.key_features ?? []).slice(0, 12),
    attributes: Object.fromEntries(Object.entries(p.structured_attributes ?? {}).filter(([, v]) => Array.isArray(v) && v.length)),
    materials: p.materials ?? [],
    category,
    offer: {
      domain: hostOf(offer),
      price: offer.price!.price!,
      currency: offer.price!.currency!.toUpperCase(),
      availability,
      condition: offer.condition ?? null,
    },
    imageUrl: image?.url ?? null,
    retrievedAt: now.toISOString(),
    hiddenText: [],
    synthetic: null,
  };
}

