import { hiddenSegments, visibleText } from "../injection";
import { LISTINGS, type Listing } from "../marketplace";
import type { ProductRecord } from "./types";

/**
 * PACT's test store: the 12 fictional laptops from the original prototype,
 * converted to catalog records. Used for regression tests and as an explicit,
 * labelled "test store" mode. Never presented as real catalog data.
 */

const domainOf = (url: string) => new URL(url).hostname;

export function toRecord(l: Listing, now = new Date()): ProductRecord {
  const visible = visibleText(l.html);
  const fees = (l.orderOverride?.fees ?? []).reduce((s, f) => s + f.amount, 0);
  return {
    id: l.id,
    provider: "test-store",
    title: l.title,
    brands: [l.seller],
    description: visible,
    keyFeatures: [],
    attributes: {},
    materials: [],
    category: "Laptops",
    offer: {
      domain: domainOf(l.url),
      price: l.checkout.itemPrice,
      currency: l.checkout.currency,
      availability: "InStock",
      condition: null,
    },
    imageUrl: null,
    retrievedAt: now.toISOString(),
    hiddenText: hiddenSegments(l.html),
    synthetic: { kind: "test-store", note: "Fictional laptop from PACT's test store, not a real product." },
    ...(l.orderOverride ? { orderPriceOverride: (l.orderOverride.itemPrice ?? l.checkout.itemPrice) + fees } : {}),
  };
}

export interface TestStoreResult {
  record: ProductRecord;
  /** The price shown in the store's listing (before checkout). */
  listedPrice: number;
}

export function searchTestStore(now = new Date()): TestStoreResult[] {
  return LISTINGS.map((l) => ({ record: toRecord(l, now), listedPrice: l.listedPrice }));
}

export function testStoreRecord(id: string, now = new Date()): ProductRecord | null {
  const l = LISTINGS.find((x) => x.id === id);
  return l ? toRecord(l, now) : null;
}
