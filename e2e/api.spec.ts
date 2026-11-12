import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * API-level tests for payment safety. They use the PayPal simulator, so they
 * are skipped when real sandbox credentials are configured.
 */

const REQUEST = "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";

type View = {
  id: string;
  contract: { hash: string };
  order: { id: string; status: string; captureId: string | null } | null;
  events: { type: string; hash: string; prevHash: string; data: Record<string, unknown>; summary: string }[];
  receipt: { signature: string };
};

async function call<T = View>(api: APIRequestContext, path: string, data: object = {}) {
  const r = await api.post(path, { data });
  return { status: r.status(), body: (await r.json()) as T & { error?: string } };
}

async function readyToPay(api: APIRequestContext, productId = "L-101") {
  const cfg = await (await api.get("/api/config")).json();
  test.skip(cfg.paypal !== "simulated", "Uses the PayPal simulator");
  let s = (await call(api, "/api/session", { text: REQUEST, mode: "test" })).body;
  await call(api, `/api/session/${s.id}/approve`, { contractHash: s.contract.hash });
  for (const step of ["discover", "select", "verify"]) await call(api, `/api/session/${s.id}/${step}`);
  s = (await call(api, `/api/session/${s.id}/purchase`, { productId })).body;
  const { orderId } = (await call<{ orderId: string }>(api, `/api/session/${s.id}/order`)).body;
  return { id: s.id, orderId };
}

const count = (s: View, type: string) => s.events.filter((e) => e.type === type).length;

test("a duplicate capture returns the original payment instead of charging again", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  await call(request, `/api/session/${id}/sim-approve`, { orderId });
  const first = await call(request, `/api/session/${id}/capture`, { orderId });
  const second = await call(request, `/api/session/${id}/capture`, { orderId });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body.order?.captureId).toBe(first.body.order?.captureId);
  expect(count(second.body, "PAYPAL_CAPTURED")).toBe(1);
});

test("two simultaneous captures produce exactly one payment", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  await call(request, `/api/session/${id}/sim-approve`, { orderId });
  const [a, b] = await Promise.all([
    call(request, `/api/session/${id}/capture`, { orderId }),
    call(request, `/api/session/${id}/capture`, { orderId }),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(a.body.order?.captureId).toBe(b.body.order?.captureId);
  const after = (await (await request.get(`/api/session/${id}`)).json()) as View;
  expect(count(after, "PAYPAL_CAPTURED")).toBe(1);
});

test("a second purchase in a paid session is refused", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  await call(request, `/api/session/${id}/sim-approve`, { orderId });
  await call(request, `/api/session/${id}/capture`, { orderId });
  const again = await call(request, `/api/session/${id}/purchase`, { productId: "L-106" });
  expect(again.status).toBe(409);
  const research = await call(request, `/api/session/${id}/discover`);
  expect(research.status).toBe(409);
});

test("retrying order creation returns the same PayPal order", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  const again = await call<{ orderId: string }>(request, `/api/session/${id}/order`);
  expect(again.body.orderId).toBe(orderId);
});

test("cancelling in PayPal charges nothing and the buyer can pay afterwards", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  const cancelled = await call(request, `/api/session/${id}/cancel`, { orderId });
  expect(cancelled.body.order?.status).toBe("CANCELLED");
  expect(count(cancelled.body, "PAYPAL_CANCELLED")).toBe(1);

  const { orderId: retry } = (await call<{ orderId: string }>(request, `/api/session/${id}/order`)).body;
  await call(request, `/api/session/${id}/sim-approve`, { orderId: retry });
  const paid = await call(request, `/api/session/${id}/capture`, { orderId: retry });
  expect(paid.body.order?.status).toBe("COMPLETED");
});

test("a declined payment method charges nothing and can be retried", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  await call(request, `/api/session/${id}/sim-approve`, { orderId, decline: true });
  const declined = await call(request, `/api/session/${id}/capture`, { orderId });
  expect(declined.status).toBe(200);
  expect(declined.body.order?.status).toBe("DECLINED");
  expect(count(declined.body, "PAYPAL_CAPTURED")).toBe(0);
  expect(count(declined.body, "PAYPAL_PAYMENT_FAILED")).toBe(1);

  const { orderId: retry } = (await call<{ orderId: string }>(request, `/api/session/${id}/order`)).body;
  await call(request, `/api/session/${id}/sim-approve`, { orderId: retry });
  const paid = await call(request, `/api/session/${id}/capture`, { orderId: retry });
  expect(paid.body.order?.status).toBe("COMPLETED");
});

test("capturing before the buyer approves in PayPal is refused", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  const r = await call(request, `/api/session/${id}/capture`, { orderId });
  expect(r.status).toBe(409);
  expect(r.body.error).toMatch(/approve the payment/i);
});

test("a receipt forged by recomputing every hash is rejected; the real one verifies", async ({ request }) => {
  const { id, orderId } = await readyToPay(request);
  await call(request, `/api/session/${id}/sim-approve`, { orderId });
  const paid = (await call(request, `/api/session/${id}/capture`, { orderId })).body;

  const ok = await call<{ valid: boolean }>(request, "/api/evidence/verify", {
    sessionId: id,
    events: paid.events,
    receipt: paid.receipt,
  });
  expect(ok.body.valid).toBe(true);

  // Same canonical-JSON + SHA-256 scheme as src/lib/canonical.ts.
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  const forged = structuredClone(paid.events);
  const cap = forged.find((e) => e.type === "PAYPAL_CAPTURED")!;
  cap.data.amount = "1.00";
  let prev = "0".repeat(64);
  for (const e of forged) {
    e.prevHash = prev;
    const { hash: _old, ...body } = e;
    void _old;
    e.hash = createHash("sha256").update(JSON.stringify(sort(body))).digest("hex");
    prev = e.hash;
  }
  const bad = await call<{ valid: boolean; signatureValid: boolean }>(request, "/api/evidence/verify", {
    sessionId: id,
    events: forged,
    receipt: paid.receipt,
  });
  expect(bad.body.valid).toBe(false);
  expect(bad.body.signatureValid).toBe(false);
});

test("the API refuses cross-site and non-JSON requests", async ({ request }) => {
  const cross = await request.post("/api/session", { data: { text: "socks under $10", mode: "test" }, headers: { origin: "https://evil.example" } });
  expect(cross.status()).toBe(403);
  const form = await request.post("/api/session", { form: { text: "socks under $10" } });
  expect(form.status()).toBe(415);
  const bad = await request.get("/api/session/not-a-uuid");
  expect(bad.status()).toBe(404);
});
