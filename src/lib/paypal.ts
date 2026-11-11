import "server-only";
import { randomUUID } from "node:crypto";
import type { OrderSummary } from "./order-verify";
import { quoteTotalCents, type CheckoutQuote } from "./quote";

/**
 * PayPal Orders v2 (sandbox). Falls back to a clearly labelled simulator when no
 * sandbox credentials are configured, so the app still runs end to end.
 *
 * Simulated orders live in the caller's session (passed in as `sim`), not in
 * process memory, so the simulator also works on serverless hosting where each
 * request may run on a different instance.
 */

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
export const paypalMode = (): "sandbox" | "simulated" =>
  process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "sandbox" : "simulated";

/** A PayPal API error with PayPal's machine-readable issue code (e.g. INSTRUMENT_DECLINED). */
export class PayPalError extends Error {
  constructor(
    public status: number,
    public issue: string | null,
    message: string,
  ) {
    super(message);
  }
}

export interface SimOrder extends OrderSummary {
  captureId: string | null;
  /** Test hook: the simulated buyer's payment method is declined at capture. */
  declineOnCapture?: boolean;
}
export type SimStore = Record<string, SimOrder>;

const money = (amount: number) => amount.toFixed(2);

function orderBody(quote: CheckoutQuote, referenceId: string, customId: string, description: string) {
  const handling = quote.fees.reduce((s, f) => s + Math.round(f.amount * 100), 0) / 100;
  const cur = quote.currency;
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: referenceId,
        custom_id: customId,
        description: description.slice(0, 127),
        amount: {
          currency_code: cur,
          value: money(quoteTotalCents(quote) / 100),
          breakdown: {
            item_total: { currency_code: cur, value: money(quote.itemPrice) },
            shipping: { currency_code: cur, value: money(quote.shipping) },
            tax_total: { currency_code: cur, value: money(quote.tax) },
            handling: { currency_code: cur, value: money(handling) },
          },
        },
        items: [
          {
            name: description.slice(0, 127),
            quantity: "1",
            unit_amount: { currency_code: cur, value: money(quote.itemPrice) },
            category: "PHYSICAL_GOODS",
          },
        ],
      },
    ],
  };
}

// ---------- sandbox ----------

let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new PayPalError(res.status, "AUTH_FAILED", `PayPal auth failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return token.value;
}

/**
 * `requestId` makes a POST idempotent on PayPal's side: retrying with the same
 * id returns the original result instead of creating or capturing twice.
 */
async function api<T>(path: string, init: RequestInit = {}, requestId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    message?: string;
    name?: string;
    details?: { issue?: string; description?: string }[];
  };
  if (!res.ok) {
    const issue = json.details?.[0]?.issue ?? json.name ?? null;
    throw new PayPalError(res.status, issue, `PayPal ${path} failed: ${res.status} ${issue ?? json.message ?? res.statusText}`);
  }
  return json as T;
}

interface PayPalOrder {
  id: string;
  status: string;
  purchase_units: {
    reference_id?: string;
    custom_id?: string;
    amount: {
      currency_code: string;
      value: string;
      breakdown?: Record<string, { value: string } | undefined>;
    };
    payments?: { captures?: { id: string; status: string }[] };
  }[];
}

function summarize(o: PayPalOrder): OrderSummary {
  const pu = o.purchase_units[0];
  const b = pu.amount.breakdown ?? {};
  return {
    id: o.id,
    status: o.status,
    currency: pu.amount.currency_code,
    total: pu.amount.value,
    breakdown: {
      itemTotal: b.item_total?.value ?? "0",
      shipping: b.shipping?.value ?? "0",
      tax: b.tax_total?.value ?? "0",
      handling: b.handling?.value ?? "0",
    },
    referenceId: pu.reference_id ?? null,
    customId: pu.custom_id ?? null,
  };
}

const captureIdOf = (o: PayPalOrder) => o.purchase_units[0]?.payments?.captures?.[0]?.id ?? null;

// ---------- public API ----------

export async function createOrder(
  quote: CheckoutQuote,
  referenceId: string,
  customId: string,
  description: string,
  sim: SimStore,
): Promise<OrderSummary> {
  const body = orderBody(quote, referenceId, customId, description);
  if (paypalMode() === "sandbox") {
    // One PayPal order per purchase approval, even if the request is retried.
    return summarize(
      await api<PayPalOrder>("/v2/checkout/orders", { method: "POST", body: JSON.stringify(body) }, `pact-order-${customId}`),
    );
  }
  const existing = Object.values(sim).find((o) => o.customId === customId && o.status !== "COMPLETED");
  if (existing) return { ...existing, status: existing.status === "APPROVED" ? "APPROVED" : "CREATED" };
  const pu = body.purchase_units[0];
  const order: SimOrder = {
    id: `SIM-${randomUUID().slice(0, 13).toUpperCase()}`,
    status: "CREATED",
    currency: pu.amount.currency_code,
    total: pu.amount.value,
    breakdown: {
      itemTotal: pu.amount.breakdown.item_total.value,
      shipping: pu.amount.breakdown.shipping.value,
      tax: pu.amount.breakdown.tax_total.value,
      handling: pu.amount.breakdown.handling.value,
    },
    referenceId: pu.reference_id,
    customId: pu.custom_id,
    captureId: null,
  };
  sim[order.id] = order;
  return order;
}

/** Simulator only: stands in for the buyer approving in the PayPal popup. */
export function simulateBuyerApproval(orderId: string, sim: SimStore, opts: { decline?: boolean } = {}) {
  const o = sim[orderId];
  if (!o) return false;
  if (o.status === "CREATED") sim[orderId] = { ...o, status: "APPROVED", declineOnCapture: Boolean(opts.decline) };
  return true;
}

export async function getOrder(orderId: string, sim: SimStore): Promise<OrderSummary> {
  if (paypalMode() === "sandbox") {
    return summarize(await api<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`));
  }
  const o = sim[orderId];
  if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "Order not found");
  return o;
}

/**
 * Captures once. Retries and duplicate calls return the original capture:
 * PayPal-Request-Id makes the sandbox call idempotent, and ORDER_ALREADY_CAPTURED
 * is resolved by reading the existing capture.
 */
export async function captureOrder(
  orderId: string,
  sim: SimStore,
  /** Increments after a declined attempt, so a retry with a new payment method isn't answered from the idempotency cache. */
  attempt = 0,
): Promise<{ status: string; captureId: string | null }> {
  if (paypalMode() === "sandbox") {
    const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
    try {
      const o = await api<PayPalOrder>(`${path}/capture`, { method: "POST" }, `pact-capture-${orderId}-${attempt}`);
      return { status: o.status, captureId: captureIdOf(o) };
    } catch (err) {
      if (err instanceof PayPalError && err.issue === "ORDER_ALREADY_CAPTURED") {
        const o = await api<PayPalOrder>(path);
        return { status: o.status, captureId: captureIdOf(o) };
      }
      throw err;
    }
  }
  const o = sim[orderId];
  if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "Order not found");
  if (o.status === "COMPLETED") return { status: "COMPLETED", captureId: o.captureId };
  if (o.status !== "APPROVED") throw new PayPalError(422, "ORDER_NOT_APPROVED", "Order has not been approved by the buyer");
  if (o.declineOnCapture) {
    // Like PayPal: the buyer has to approve again with another payment method.
    sim[orderId] = { ...o, status: "CREATED", declineOnCapture: false };
    throw new PayPalError(422, "INSTRUMENT_DECLINED", "The payment method was declined");
  }
  const captureId = `SIMCAP-${randomUUID().slice(0, 10).toUpperCase()}`;
  sim[orderId] = { ...o, status: "COMPLETED", captureId };
  return { status: "COMPLETED", captureId };
}
