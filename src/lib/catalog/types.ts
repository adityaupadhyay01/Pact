/**
 * A product as PACT sees it, normalised from a catalog provider.
 *
 * Offer URLs are deliberately not stored: Channel3's caching guide says they are
 * short-lived and must be fetched fresh, and PACT only shows the merchant domain.
 */
export interface Offer {
  domain: string;
  price: number;
  currency: string;
  availability: "InStock" | "OutOfStock" | "Unknown";
  condition: "new" | "used" | null;
}

export interface ProductRecord {
  id: string;
  provider: "channel3" | "test-store";
  title: string;
  brands: string[];
  description: string | null;
  keyFeatures: string[];
  /** Canonical catalog attributes, e.g. { color: ["black"] }. */
  attributes: Record<string, string[]>;
  materials: string[];
  category: string | null;
  offer: Offer;
  imageUrl: string | null;
  retrievedAt: string;
  /** Text on the source page that buyers can't see (test store and Seller Mode only). */
  hiddenText: string[];
  /** Set whenever the record is not real catalog data. Synthetic data is always labelled. */
  synthetic: null | { kind: "test-store" | "seller-mode"; note: string };
  /** Test only: what the simulated merchant sends to PayPal instead of the offer price. */
  orderPriceOverride?: number;
}

export interface SearchRequest {
  query: string;
  maxPrice: number | null;
  currency: string;
  conditions: ("new" | "used")[];
  limit: number;
}

export class CatalogError extends Error {
  constructor(
    public kind: "unconfigured" | "auth" | "credits" | "rate_limited" | "timeout" | "not_found" | "bad_request" | "upstream",
    message: string,
  ) {
    super(message);
  }
}
