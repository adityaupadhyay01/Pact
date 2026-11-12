import { deepFreeze, formatMoney, hashObject, toCents } from "./canonical";
import type { ContractVersion } from "./contract";
import { quoteTotalCents, type CheckoutQuote } from "./quote";
import type { Check, Status } from "./rules";
import { worst } from "./rules";

/**
 * What the buyer approved: this contract, this product, this exact price, and
 * the exact evidence PACT verified (by hash). Changing any of them needs a new approval.
 */
export interface PurchaseSnapshot {
  readonly contractHash: string;
  readonly contractVersion: number;
  readonly listingId: string;
  readonly quote: CheckoutQuote;
  readonly acknowledgedFlags: string[];
  readonly evidenceHash?: string;
  readonly seller?: string;
  /** When the evidence behind this approval was retrieved. */
  readonly retrievedAt?: string;
  readonly approvedAt: string;
  readonly hash: string;
}

export function createSnapshot(
  contract: ContractVersion,
  listingId: string,
  quote: CheckoutQuote,
  acknowledgedFlags: string[],
  now: Date = new Date(),
  binding: { evidenceHash?: string; seller?: string; retrievedAt?: string } = {},
): PurchaseSnapshot {
  const body = {
    contractHash: contract.hash,
    contractVersion: contract.version,
    listingId,
    quote,
    acknowledgedFlags,
    ...binding,
    approvedAt: now.toISOString(),
  };
  return deepFreeze({ ...body, hash: hashObject(body) });
}

/** True when the snapshot's hash still matches its contents (it wasn't altered after approval). */
export function verifySnapshot(s: PurchaseSnapshot): boolean {
  const { hash, ...body } = s;
  return hashObject(body) === hash;
}

/** A PayPal order, normalised from the Orders v2 API response. */
export interface OrderSummary {
  id: string;
  status: string;
  currency: string;
  total: string;
  breakdown: { itemTotal: string; shipping: string; tax: string; handling: string };
  referenceId: string | null;
  customId: string | null;
}

const cents = (v: string) => toCents(Number(v || "0"));

/**
 * Independent check of what PayPal will actually charge, run immediately before
 * capture. The order is fetched from PayPal, not taken from the seller.
 */
export function verifyOrder(snapshot: PurchaseSnapshot, order: OrderSummary): { ok: boolean; checks: Check[] } {
  const q = snapshot.quote;
  const fees = q.fees.reduce((s, f) => s + toCents(f.amount), 0);
  const cur = q.currency;
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, expected: string, actual: string, detail: string) =>
    checks.push({ id, label, status: ok ? "pass" : "block", expected, actual, detail });
  const m = (c: number) => formatMoney(c / 100, cur);

  add("order-ref", "Right product", order.referenceId === snapshot.listingId,
    snapshot.listingId, order.referenceId ?? "missing", "PayPal order reference must match the approved listing.");
  add("order-binding", "Linked to your approval", order.customId === snapshot.hash,
    snapshot.hash.slice(0, 12) + "…", (order.customId ?? "missing").slice(0, 12) + "…",
    "The order must carry the hash of the purchase the buyer approved.");
  add("order-currency", "Currency", order.currency === cur, cur, order.currency, "Charged currency must match.");
  add("order-total", "Total charged", cents(order.total) === quoteTotalCents(q),
    m(quoteTotalCents(q)), formatMoney(Number(order.total), order.currency),
    "PayPal total must equal the approved all-in total, to the cent.");
  add("order-item", "Item price", cents(order.breakdown.itemTotal) === toCents(q.itemPrice),
    m(toCents(q.itemPrice)), m(cents(order.breakdown.itemTotal)), "Item price in the PayPal order.");
  add("order-shipping", "Shipping", cents(order.breakdown.shipping) === toCents(q.shipping),
    m(toCents(q.shipping)), m(cents(order.breakdown.shipping)), "Shipping in the PayPal order.");
  add("order-tax", "Tax", cents(order.breakdown.tax) === toCents(q.tax),
    m(toCents(q.tax)), m(cents(order.breakdown.tax)), "Tax in the PayPal order.");
  add("order-fees", "Fees / handling", cents(order.breakdown.handling) === fees,
    m(fees), m(cents(order.breakdown.handling)), "Any fee not in the approved quote is unauthorised.");

  const status: Status = worst(checks.map((c) => c.status));
  return { ok: status === "pass", checks };
}
