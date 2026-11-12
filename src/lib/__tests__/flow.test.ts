import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductRecord } from "../catalog/types";
import type { Constraint, Requirements } from "../contract";
import type { RawExtraction } from "../facts";

/**
 * Integration tests of the whole PACT flow (src/lib/pact.ts) with the external
 * services replaced by deterministic fixtures: Gemini (intent, agent, reader)
 * and Channel3 (search, product detail). PayPal runs in its built-in simulator,
 * storage and rate limits in memory. No network is used.
 */

const state = vi.hoisted(() => ({
  ai: true,
  catalog: true,
  search: [] as unknown[],
  detail: null as null | ((id: string) => unknown),
  choose: null as null | ((cands: { id: string }[]) => unknown),
  aiError: null as null | Error,
  failCapture: null as null | Error,
  captureOverride: null as null | Record<string, unknown>,
}));

vi.mock("../ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ai")>();
  return {
    ...real,
    geminiConfigured: () => state.ai,
    geminiModel: () => "fixture-model",
    geminiIntent: vi.fn(async (text: string) => {
      if (state.aiError) throw state.aiError;
      return intentFor(text);
    }),
    geminiChoose: vi.fn(async (_req: Requirements, cands: { id: string }[]) => {
      if (state.aiError) throw state.aiError;
      return state.choose
        ? state.choose(cands)
        : { chosenId: cands[0].id, reasons: ["Matches the cocoa requirement."], claims: [{ constraintId: "c1", value: "72" }], summary: "72% cocoa, under budget." };
    }),
    geminiExtract: vi.fn(async (constraints: Constraint[], evidence: string) => {
      if (state.aiError) throw state.aiError;
      return readCocoa(constraints, evidence);
    }),
  };
});

vi.mock("../catalog/channel3", () => ({
  channel3Configured: () => state.catalog,
  searchChannel3: vi.fn(async () => {
    if (state.search instanceof Error) throw state.search;
    return structuredClone(state.search);
  }),
  productChannel3: vi.fn(async (id: string) => {
    const r = state.detail ? state.detail(id) : defaultDetail(id);
    if (r instanceof Error) throw r;
    return r;
  }),
}));

vi.mock("../paypal", async (importOriginal) => {
  const real = await importOriginal<typeof import("../paypal")>();
  return {
    ...real,
    captureOrder: vi.fn(async (...args: Parameters<typeof real.captureOrder>) => {
      if (state.failCapture) throw state.failCapture;
      const r = await real.captureOrder(...args);
      return state.captureOverride ? { ...r, ...state.captureOverride } : r;
    }),
  };
});

import { AiError } from "../ai";
import { CatalogError } from "../catalog/types";
import { verifyOrder } from "../order-verify";
import { PayPalError } from "../paypal";
import { ConfigError } from "../env";
import { inspect } from "../inspector";
import { resetMemoryCounters } from "../ratelimit";
import { applyAttack, expectedOutcome, SELLER_ATTACKS } from "../seller-mode";
import { cleanupExpired, resetCleanupTimer } from "../store";
import * as pact from "../pact";

// ------------------------------------------------------------------ fixtures (test data only)

const TEXT = "Dark chocolate bar with at least 70% cocoa under $5";

function intentFor(text: string) {
  return {
    isShoppingRequest: true,
    product: "dark chocolate bar",
    productQuote: "Dark chocolate bar",
    searchQuery: "70% dark chocolate bar",
    budget: text.includes("under $5") ? { max: 5, currency: "USD", userQuote: "under $5" } : null,
    constraints: [{ label: "Cocoa", attribute: "cocoa_percent", operator: "gte" as const, value: "70", unit: "%", mandatory: true, userQuote: "at least 70% cocoa" }],
    clarificationQuestion: null,
  };
}

/** A minimal stand-in for Gemini's reader: quotes "NN% cocoa" when the evidence has it. */
function readCocoa(constraints: Constraint[], evidence: string): RawExtraction {
  const m = /(\d+)% cocoa/.exec(evidence);
  return {
    facts: constraints.map((c) =>
      m ? { constraintId: c.id, stated: true, value: m[1], unit: "%", quote: m[0] } : { constraintId: c.id, stated: false, value: null, unit: null, quote: null },
    ),
    instructionsToAI: { found: false, quote: null },
  };
}

function bar(id: string, cocoa: number, price: number, over: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id,
    provider: "channel3",
    title: `Example ${cocoa}% Dark Chocolate Bar`,
    brands: ["Example"],
    description: `Smooth dark chocolate with ${cocoa}% cocoa.`,
    keyFeatures: [],
    attributes: {},
    materials: [],
    category: "Chocolate",
    offer: { domain: "grocer.example", price, currency: "USD", availability: "InStock", condition: "new" },
    imageUrl: null,
    retrievedAt: new Date().toISOString(),
    hiddenText: [],
    synthetic: null,
    ...over,
  };
}
const SEARCH = () => [bar("c3-a", 72, 3.49), bar("c3-b", 85, 4.29), bar("c3-c", 60, 2.99)];
const defaultDetail = (id: string) => {
  const r = (state.search as ProductRecord[]).find((p) => p.id === id);
  return r ? { ...structuredClone(r), retrievedAt: new Date().toISOString() } : null;
};

let n = 0;
const visitor = () => `test-client-${++n}`;

async function liveCheck(text = TEXT, sellerAttack: (typeof SELLER_ATTACKS)[number] | null = null) {
  let s = await pact.startSession(text, { mode: "live", sellerAttack, client: visitor() });
  s = await pact.approveContract(s.id, s.contract.hash);
  s = await pact.discover(s.id);
  s = await pact.select(s.id);
  return pact.verify(s.id);
}

async function pay(id: string, productId: string, acks: string[] = [], expected?: { price?: number; currency?: string }) {
  await pact.approvePurchase(id, productId, acks, expected);
  const { orderId } = await pact.createPaypalOrder(id);
  await pact.simulateApproval(id, orderId);
  return { view: await pact.capture(id, orderId), orderId };
}

const g = globalThis as unknown as { __pactSessions: Map<string, Record<string, unknown>> };

beforeEach(() => {
  Object.assign(state, { ai: true, catalog: true, search: SEARCH(), detail: null, choose: null, aiError: null, failCapture: null, captureOverride: null });
  resetMemoryCounters();
  g.__pactSessions?.clear();
  vi.stubEnv("PAYPAL_CLIENT_ID", "");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ------------------------------------------------------------------ the critical journey

describe("live flow, end to end", () => {
  it("request → grounded requirements → agent pick → independent check → exact approval → verified capture → signed receipt", async () => {
    const v = await liveCheck();
    expect(v.contract.requirements.constraints[0]).toMatchObject({ value: "70", unit: "%", userQuote: "at least 70% cocoa" });
    expect(v.agent?.engine).toBe("gemini");
    expect(v.verification?.subject.productId).toBe("c3-a");
    expect(v.verification?.subject.evaluation.verdict).toBe("PASS");
    expect(v.verification?.subject.reader).toBe("gemini");
    expect(v.isTest).toBe(false);
    expect(v.verification?.subject.record.synthetic).toBeNull();

    const { view, orderId } = await pay(v.id, "c3-a");
    expect(view.order?.status).toBe("COMPLETED");
    expect(view.snapshot).toMatchObject({
      listingId: "c3-a",
      seller: "grocer.example",
      quote: { itemPrice: 3.49, currency: "USD" },
      evidenceHash: view.verification?.subject.evidence.hash,
      retrievedAt: view.verification?.subject.evidence.retrievedAt,
      contractHash: view.contract.hash,
    });
    const captured = view.events.find((e) => e.type === "PAYPAL_CAPTURED")!;
    expect(captured.data).toMatchObject({ orderId, amount: "3.49", currency: "USD" });
    expect(view.chain.valid).toBe(true);
    expect(pact.verifyReceiptPackage(view.id, view.events, view.receipt.signature).valid).toBe(true);
    expect(view.receipt.test).toBe(false);
  });

  it("an edited receipt fails verification", async () => {
    const v = await liveCheck();
    const { view } = await pay(v.id, "c3-a");
    const forged = structuredClone(view.events);
    const cap = forged.find((e) => e.type === "PAYPAL_CAPTURED")!;
    (cap.data as Record<string, unknown>).amount = "0.01";
    expect(pact.verifyReceiptPackage(view.id, forged, view.receipt.signature).valid).toBe(false);
  });
});

// ------------------------------------------------------------------ AI and catalog failures

describe("AI and catalog failures are explicit, never silent", () => {
  it("no Gemini: live mode refuses with AI_UNAVAILABLE (no laptop parser fallback)", async () => {
    state.ai = false;
    await expect(pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() })).rejects.toMatchObject({ status: 503, code: "AI_UNAVAILABLE" });
  });

  it("Gemini quota, timeout or malformed output stops the step", async () => {
    let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    s = await pact.approveContract(s.id, s.contract.hash);
    await pact.discover(s.id);
    for (const kind of ["rate_limited", "timeout", "invalid_output"] as const) {
      state.aiError = new AiError(kind, "fixture");
      await expect(pact.select(s.id)).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
    }
  });

  it("gibberish never reaches Gemini", async () => {
    const { geminiIntent } = await import("../ai");
    vi.mocked(geminiIntent).mockClear();
    await expect(pact.startSession("qwrtzp xkcdvbn", { mode: "live", sellerAttack: null, client: visitor() })).rejects.toMatchObject({ code: "NOT_UNDERSTOOD" });
    expect(geminiIntent).not.toHaveBeenCalled();
  });

  it("a missing budget blocks the search until the buyer sets one", async () => {
    const s = await pact.startSession("Dark chocolate bar with at least 70% cocoa", { mode: "live", sellerAttack: null, client: visitor() });
    expect(s.contract.requirements.budget).toBeNull();
    expect(s.missing).toContain("budget");
    await expect(pact.approveContract(s.id, s.contract.hash)).rejects.toMatchObject({ code: "NEEDS_BUDGET" });
  });

  it("the agent can only pick a real candidate", async () => {
    state.choose = () => ({ chosenId: "invented-product", reasons: ["x"], claims: [], summary: "x" });
    let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    s = await pact.approveContract(s.id, s.contract.hash);
    await pact.discover(s.id);
    await expect(pact.select(s.id)).rejects.toMatchObject({ code: "AGENT_INVALID" });
  });

  it.each([
    ["credits", 503],
    ["rate_limited", 429],
    ["timeout", 503],
    ["outage", 503],
  ] as const)("Channel3 %s → CATALOG_UNAVAILABLE (%i)", async (kind, status) => {
    state.search = new CatalogError(kind, "fixture") as unknown as unknown[];
    let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    s = await pact.approveContract(s.id, s.contract.hash);
    await expect(pact.discover(s.id)).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE", status });
  });

  it("empty search: no products, nothing to choose", async () => {
    state.search = [];
    let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    s = await pact.approveContract(s.id, s.contract.hash);
    s = await pact.discover(s.id);
    expect(s.discovery?.candidates).toEqual([]);
    await expect(pact.select(s.id)).rejects.toMatchObject({ code: "NO_PRODUCTS" });
  });

  it("a repeated search for the same requirements reuses results (no extra credit)", async () => {
    const { searchChannel3 } = await import("../catalog/channel3");
    vi.mocked(searchChannel3).mockClear();
    let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    s = await pact.approveContract(s.id, s.contract.hash);
    await pact.discover(s.id);
    await pact.discover(s.id);
    expect(searchChannel3).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ issue 1: stale evidence

describe("evidence freshness (fail closed)", () => {
  async function upToSelect() {
    let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    s = await pact.approveContract(s.id, s.contract.hash);
    await pact.discover(s.id);
    return pact.select(s.id);
  }

  it("successful refresh: the verdict is based on the re-fetched record and its timestamp", async () => {
    const s = await upToSelect();
    const searchedAt = s.discovery!.candidates[0].retrievedAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5_000);
    const v = await pact.verify(s.id);
    expect(Date.parse(v.verification!.subject.evidence.retrievedAt)).toBeGreaterThan(Date.parse(searchedAt));
  });

  it.each([
    ["failed refresh", () => new CatalogError("outage", "fixture")],
    ["timeout", () => new CatalogError("timeout", "fixture")],
    ["empty product-detail response", () => null],
  ])("%s: no verdict, VERIFICATION_UNAVAILABLE, nothing approvable", async (_name, make) => {
    const s = await upToSelect();
    state.detail = () => make();
    await expect(pact.verify(s.id)).rejects.toMatchObject({ status: 503, code: "VERIFICATION_UNAVAILABLE" });
    const after = await pact.getView(s.id);
    expect(after.verification).toBeNull();
    expect(after.events.at(-1)?.type).toBe("VERIFICATION_UNAVAILABLE");
    await expect(pact.approvePurchase(s.id, "c3-a", [])).rejects.toMatchObject({ status: 409 });
  });

  it("a previous verdict is withdrawn when a later refresh fails", async () => {
    const s = await upToSelect();
    await pact.verify(s.id);
    state.detail = () => new CatalogError("timeout", "fixture");
    await expect(pact.verify(s.id)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    expect((await pact.getView(s.id)).verification).toBeNull();
  });

  it("repeated refresh attempts: fails, then succeeds once the catalog is back", async () => {
    const s = await upToSelect();
    state.detail = () => new CatalogError("timeout", "fixture");
    await expect(pact.verify(s.id)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    await expect(pact.verify(s.id)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    state.detail = null;
    const v = await pact.verify(s.id);
    expect(v.verification?.subject.evaluation.verdict).toBe("PASS");
  });

  it("changed product identity is refused", async () => {
    const s = await upToSelect();
    state.detail = () => bar("someone-else", 72, 3.49);
    await expect(pact.verify(s.id)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  it("alternatives that can't be re-fetched are unchecked, never verified from search data", async () => {
    const s = await upToSelect();
    state.detail = (id) => (id === "c3-a" ? defaultDetail(id) : new CatalogError("timeout", "fixture"));
    const v = await pact.verify(s.id);
    expect(v.verification?.alternatives).toEqual([]);
    expect(v.verification?.unchecked.sort()).toEqual(["c3-b", "c3-c"]);
  });

  describe("at approval, PACT re-fetches, re-reads and re-evaluates", () => {
    it("changed price → EVIDENCE_CHANGED, then approval of the new price works", async () => {
      const v = await liveCheck();
      state.detail = (id) => ({ ...defaultDetail(id)!, offer: { ...defaultDetail(id)!.offer, price: 3.99 } });
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
      const after = await pact.getView(v.id);
      expect(after.verification?.subject.record.offer.price).toBe(3.99);
      expect(after.snapshot).toBeNull();
      // The price went up since the search, so the buyer must acknowledge that before approving.
      expect(after.verification?.subject.evaluation.checks.find((c) => c.id === "price-drift")?.status).toBe("flag");
      await expect(pact.approvePurchase(v.id, "c3-a", [], { price: 3.99 })).rejects.toMatchObject({ code: "NEEDS_ACK" });
      const ok = await pact.approvePurchase(v.id, "c3-a", ["price-drift"], { price: 3.99, currency: "USD" });
      expect(ok.snapshot?.quote.itemPrice).toBe(3.99);
    });

    it("a price the buyer didn't see is refused, even if the catalog is unchanged", async () => {
      const v = await liveCheck();
      await expect(pact.approvePurchase(v.id, "c3-a", [], { price: 2.0 })).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    });

    it("changed specifications → verdict re-evaluated → BLOCKED", async () => {
      const v = await liveCheck();
      state.detail = (id) => ({ ...defaultDetail(id)!, description: "Smooth dark chocolate with 55% cocoa." });
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
      expect((await pact.getView(v.id)).verification?.subject.evaluation.verdict).toBe("BLOCK");
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ code: "BLOCKED" });
    });

    it("changed availability → EVIDENCE_CHANGED and BLOCK", async () => {
      const v = await liveCheck();
      state.detail = (id) => ({ ...defaultDetail(id)!, offer: { ...defaultDetail(id)!.offer, availability: "OutOfStock" } });
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
      expect((await pact.getView(v.id)).verification?.subject.evaluation.verdict).toBe("BLOCK");
    });

    it("failed refresh → nothing approved (no stale fallback)", async () => {
      const v = await liveCheck();
      state.detail = () => new CatalogError("timeout", "fixture");
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ status: 503, code: "CATALOG_UNAVAILABLE" });
      expect((await pact.getView(v.id)).snapshot).toBeNull();
    });

    it("product removed or replaced → refused", async () => {
      const v = await liveCheck();
      state.detail = () => null;
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ code: "PRODUCT_GONE" });
      state.detail = () => bar("other", 72, 3.49);
      await expect(pact.approvePurchase(v.id, "c3-a", [])).rejects.toMatchObject({ code: "PRODUCT_CHANGED" });
    });

    it("expired approval → PayPal order refused until the buyer confirms again", async () => {
      const v = await liveCheck();
      await pact.approvePurchase(v.id, "c3-a", []);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + pact.APPROVAL_TTL_MS + 1000);
      await expect(pact.createPaypalOrder(v.id)).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    });

    it("a tampered approval is refused", async () => {
      const v = await liveCheck();
      await pact.approvePurchase(v.id, "c3-a", []);
      const stored = g.__pactSessions.get(v.id) as { snapshot: { quote: { itemPrice: number } } };
      stored.snapshot = { ...stored.snapshot, quote: { ...stored.snapshot.quote, itemPrice: 0.01 } };
      await expect(pact.createPaypalOrder(v.id)).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    });

    it("changing a must-have after approval invalidates the purchase approval", async () => {
      const v = await liveCheck();
      await pact.approvePurchase(v.id, "c3-a", []);
      const r = await pact.revise(v.id, { budget: { max: 4, currency: "USD" } });
      expect(r.snapshot).toBeNull();
      expect(r.approved).toBe(false);
      await expect(pact.createPaypalOrder(v.id)).rejects.toMatchObject({ status: 409 });
    });
  });
});

// ------------------------------------------------------------------ payments

describe("payments (PayPal simulator, labelled SIMULATED)", () => {
  it("duplicate capture returns the original capture; one PAYPAL_CAPTURED event", async () => {
    const v = await liveCheck();
    const { view, orderId } = await pay(v.id, "c3-a");
    const again = await pact.capture(v.id, orderId);
    expect(again.order?.captureId).toBe(view.order?.captureId);
    expect(again.events.filter((e) => e.type === "PAYPAL_CAPTURED")).toHaveLength(1);
    await expect(pact.approvePurchase(v.id, "c3-b", [])).rejects.toMatchObject({ status: 409 });
  });

  it("cancellation charges nothing and can be retried", async () => {
    const v = await liveCheck();
    await pact.approvePurchase(v.id, "c3-a", []);
    const { orderId } = await pact.createPaypalOrder(v.id);
    const c = await pact.cancelPayment(v.id, orderId);
    expect(c.order?.status).toBe("CANCELLED");
    const { orderId: retry } = await pact.createPaypalOrder(v.id);
    await pact.simulateApproval(v.id, retry);
    expect((await pact.capture(v.id, retry)).order?.status).toBe("COMPLETED");
  });

  it("a declined card charges nothing and can be retried", async () => {
    const v = await liveCheck();
    await pact.approvePurchase(v.id, "c3-a", []);
    const { orderId } = await pact.createPaypalOrder(v.id);
    await pact.simulateApproval(v.id, orderId, { decline: true });
    const d = await pact.capture(v.id, orderId);
    expect(d.order?.status).toBe("DECLINED");
    expect(d.events.some((e) => e.type === "PAYPAL_CAPTURED")).toBe(false);
  });

  it("a failed capture is reported, not marked paid", async () => {
    const v = await liveCheck();
    await pact.approvePurchase(v.id, "c3-a", []);
    const { orderId } = await pact.createPaypalOrder(v.id);
    await pact.simulateApproval(v.id, orderId);
    state.failCapture = new PayPalError(500, "INTERNAL_SERVER_ERROR", "fixture");
    await expect(pact.capture(v.id, orderId)).rejects.toMatchObject({ code: "PAYMENTS_UNAVAILABLE" });
    const after = await pact.getView(v.id);
    expect(after.order?.status).not.toBe("COMPLETED");
    expect(after.events.some((e) => e.type === "PAYPAL_PAYMENT_FAILED")).toBe(true);
  });

  it("PayPal capturing a different amount is never shown as a verified payment", async () => {
    const v = await liveCheck();
    await pact.approvePurchase(v.id, "c3-a", []);
    const { orderId } = await pact.createPaypalOrder(v.id);
    await pact.simulateApproval(v.id, orderId);
    state.captureOverride = { amount: "9.99" };
    const r = await pact.capture(v.id, orderId);
    expect(r.order?.status).toBe("CAPTURE_MISMATCH");
    expect(r.events.some((e) => e.type === "PAYPAL_CAPTURED")).toBe(false);
  });

  it("a pending capture isn't counted as paid", async () => {
    const v = await liveCheck();
    await pact.approvePurchase(v.id, "c3-a", []);
    const { orderId } = await pact.createPaypalOrder(v.id);
    await pact.simulateApproval(v.id, orderId);
    state.captureOverride = { status: "PENDING" };
    const r = await pact.capture(v.id, orderId);
    expect(r.order?.status).toBe("PENDING");
    expect(r.events.some((e) => e.type === "PAYPAL_CAPTURE_PENDING")).toBe(true);
  });

  it("order verification blocks amount and currency mismatches", async () => {
    const v = await liveCheck();
    const ok = await pact.approvePurchase(v.id, "c3-a", []);
    const snap = ok.snapshot!;
    const order = {
      id: "O",
      status: "APPROVED",
      currency: "USD",
      total: "3.49",
      breakdown: { itemTotal: "3.49", shipping: "0.00", tax: "0.00", handling: "0.00" },
      referenceId: "c3-a",
      customId: snap.hash,
    };
    expect(verifyOrder(snap, order).ok).toBe(true);
    expect(verifyOrder(snap, { ...order, currency: "EUR" }).checks.find((c) => c.id === "order-currency")?.status).toBe("block");
    expect(verifyOrder(snap, { ...order, total: "3.50" }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ issue 4: Seller Mode

describe("Seller Mode", () => {
  it.each(SELLER_ATTACKS)("%s has its defined outcome and TEST labels", async (attack) => {
    const v = await liveCheck(TEXT, attack);
    const expected = expectedOutcome(attack, v.contract.requirements);
    expect(v.isTest).toBe(true);
    expect(v.receipt.test).toBe(true);
    expect(v.events.some((e) => e.type === "TEST_MODE")).toBe(true);
    expect(v.events.some((e) => e.type === "SELLER_MODE_APPLIED")).toBe(true);
    expect(v.verification?.subject.record.synthetic?.kind).toBe("seller-mode");
    // Alternatives are real catalog evidence and stay untouched.
    expect(v.verification?.alternatives.every((a) => a.record.synthetic === null)).toBe(true);

    if (expected.stage === "verification") {
      expect(v.verification?.subject.evaluation.verdict).toBe(expected.verdict);
    } else {
      expect(v.verification?.subject.evaluation.verdict).toBe("PASS");
      await pact.approvePurchase(v.id, "c3-a", []);
      const { orderId } = await pact.createPaypalOrder(v.id);
      await pact.simulateApproval(v.id, orderId);
      const r = await pact.capture(v.id, orderId);
      expect(r.order?.verification?.ok).toBe(false);
      expect(r.order?.status).not.toBe("COMPLETED");
      expect(r.events.some((e) => e.type === "PAYPAL_CAPTURED")).toBe(false);
    }
  });

  it("normal mode never applies an attack", async () => {
    const v = await liveCheck();
    expect(v.sellerAttack).toBeNull();
    expect(v.events.some((e) => e.type === "SELLER_MODE_APPLIED" || e.type === "TEST_MODE")).toBe(false);
    expect([v.verification!.subject, ...v.verification!.alternatives].every((x) => x.record.synthetic === null)).toBe(true);
  });

  it("test store runs all three attacks with their outcomes", async () => {
    const text = "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";
    for (const attack of SELLER_ATTACKS) {
      let s = await pact.startSession(text, { mode: "test", sellerAttack: attack, client: visitor() });
      s = await pact.approveContract(s.id, s.contract.hash);
      for (const step of ["discover", "select", "verify"] as const) s = await pact[step](s.id);
      const e = expectedOutcome(attack, s.contract.requirements);
      if (e.stage === "verification") expect(s.verification?.subject.evaluation.verdict).toBe(e.verdict);
      expect(s.receipt.test).toBe(true);
    }
  });

  describe("spec contradiction across constraint types: a mandatory contradiction never passes", () => {
    const base = bar("p", 72, 3.49, {
      title: "Example Item",
      description: "Great item.",
      attributes: {},
    });
    const cases: [string, Constraint, Partial<ProductRecord>][] = [
      ["numeric gte", { id: "c1", label: "Cocoa", attribute: "cocoa_percent", operator: "gte", value: "70", unit: "%", mandatory: true, origin: "request", userQuote: "70% cocoa" }, { description: "With 72% cocoa." }],
      ["numeric lte", { id: "c1", label: "Weight", attribute: "weight", operator: "lte", value: "200", unit: "g", mandatory: true, origin: "request", userQuote: "under 200g" }, { description: "Weight 150 g." }],
      ["numeric eq", { id: "c1", label: "Size", attribute: "size", operator: "eq", value: "9", unit: null, mandatory: true, origin: "request", userQuote: "size 9" }, { description: "Size 9." }],
      ["text eq", { id: "c1", label: "Color", attribute: "color", operator: "eq", value: "black", unit: null, mandatory: true, origin: "request", userQuote: "black" }, { description: "Color black." }],
      ["condition", { id: "c1", label: "Condition", attribute: "condition", operator: "eq", value: "new", unit: null, mandatory: true, origin: "request", userQuote: "new" }, {}],
      ["required feature", { id: "c1", label: "Noise cancellation", attribute: "noise_cancellation", operator: "present", value: null, unit: null, mandatory: true, origin: "request", userQuote: "noise cancellation" }, { description: "Active noise cancellation." }],
      ["contains", { id: "c1", label: "Organic", attribute: "organic", operator: "contains", value: "organic", unit: null, mandatory: true, origin: "request", userQuote: "organic" }, { description: "Certified organic." }],
      ["excludes", { id: "c1", label: "Nut free", attribute: "allergens", operator: "excludes", value: "nuts", unit: null, mandatory: true, origin: "request", userQuote: "no nuts" }, { description: "Allergens: none." }],
      ["unsupported unit", { id: "c1", label: "Capacity", attribute: "capacity", operator: "gte", value: "30", unit: "cups", mandatory: true, origin: "request", userQuote: "30 cups" }, { description: "Brews 30 cups." }],
    ];
    const r = (c: Constraint): Requirements => ({ product: "item", searchQuery: "item", constraints: [c], budget: { max: 5, currency: "USD", scope: "item_price", origin: "request", userQuote: "under $5" } });

    it.each(cases)("%s → BLOCK with conflicting or violated evidence", (_name, c, over) => {
      const original = { ...base, ...over };
      const attacked = applyAttack(original, "spec_contradiction", r(c));
      // Conflicting evidence: the text says the requirement is met, the seller's structured field says it isn't.
      const conflicting = inspect({
        requirements: r(c),
        record: attacked,
        extraction: { facts: [{ constraintId: "c1", stated: true, value: c.value ?? "Yes", unit: c.unit, quote: "Example Item" }], instructionsToAI: { found: false, quote: null } },
      });
      // Missing text evidence: only the contradicting field speaks.
      const missing = inspect({ requirements: r(c), record: attacked, extraction: { facts: [], instructionsToAI: { found: false, quote: null } } });
      for (const res of [conflicting, missing]) {
        expect(res.evaluation.verdict).toBe("BLOCK");
        expect(["conflicting", "violated"]).toContain(res.evaluation.checks.find((x) => x.id === "c1")?.state);
      }
      expect(attacked.synthetic?.kind).toBe("seller-mode");
      expect(original.synthetic).toBeNull(); // the real record is never modified
    });

    it("no mandatory requirement → FLAG (stock and details become uncertain), never PASS", () => {
      const pref: Constraint = { ...cases[0][1], mandatory: false };
      const attacked = applyAttack(base, "spec_contradiction", r(pref));
      const res = inspect({ requirements: r(pref), record: attacked, extraction: null });
      expect(res.evaluation.verdict).toBe("FLAG");
      expect(expectedOutcome("spec_contradiction", r(pref)).verdict).toBe("FLAG");
    });
  });
});

// ------------------------------------------------------------------ issue 2: rate limiting

describe("rate limiting", () => {
  it("per-visitor limit on starting live checks", async () => {
    const who = visitor();
    for (let i = 0; i < 8; i++) await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: who });
    await expect(pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: who })).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    // Another visitor is unaffected.
    await expect(pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() })).resolves.toBeTruthy();
  });

  it("new sessions don't reset a visitor's search allowance", async () => {
    const who = visitor();
    let blocked = false;
    for (let i = 0; i < 8 && !blocked; i++) {
      let s = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: who });
      s = await pact.approveContract(s.id, s.contract.hash);
      for (let j = 0; j < 4; j++) {
        // Each revision forces a new search (new requirements → no reuse).
        s = await pact.revise(s.id, { budget: { max: 5 + j + i * 10 + 1, currency: "USD" } });
        s = await pact.approveContract(s.id, s.contract.hash);
        try {
          await pact.discover(s.id);
        } catch (e) {
          expect(e).toMatchObject({ code: "RATE_LIMITED" });
          blocked = true;
          break;
        }
      }
    }
    expect(blocked).toBe(true);
  });
});

describe("rate limiter internals", () => {
  it("memory counter: allows up to the limit, atomically under concurrency", async () => {
    const { hit } = await import("../ratelimit");
    const results = await Promise.all(Array.from({ length: 20 }, () => hit("t:concurrent", 5, 60)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("production without shared storage fails closed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { hit } = await import("../ratelimit");
    await expect(hit("t:prod", 5, 60)).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
  });
});

// ------------------------------------------------------------------ issue 3: retention and recovery

describe("sessions: recovery, expiry and cleanup", () => {
  it("a session is recovered by id with the same state", async () => {
    const v = await liveCheck();
    const back = await pact.getView(v.id);
    expect(back.contract.hash).toBe(v.contract.hash);
    expect(back.events.length).toBe(v.events.length);
  });

  it("expiry boundary: open until the instant it expires, gone after; cleanup deletes only expired", async () => {
    const a = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() });
    const expiresAt = Date.parse((g.__pactSessions.get(a.id) as { expiresAt: string }).expiresAt);
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(expiresAt);
    await expect(pact.getView(a.id)).resolves.toBeTruthy();
    resetCleanupTimer();
    expect(await cleanupExpired(expiresAt)).toBe(0);

    vi.setSystemTime(expiresAt + 1);
    await expect(pact.getView(a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const b = await pact.startSession(TEXT, { mode: "live", sellerAttack: null, client: visitor() }); // active, created now
    resetCleanupTimer();
    expect(await cleanupExpired(expiresAt + 1)).toBe(1);
    expect(g.__pactSessions.has(a.id)).toBe(false);
    expect(g.__pactSessions.has(b.id)).toBe(true);
    // Safe to retry.
    resetCleanupTimer();
    expect(await cleanupExpired(expiresAt + 1)).toBe(0);
  });

  it("production without a database refuses instead of pretending to save", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVIDENCE_SECRET", "x".repeat(40));
    await expect(pact.startSession(TEXT, { mode: "test", sellerAttack: null, client: visitor() })).rejects.toBeInstanceOf(ConfigError);
  });

  it("production without a signing key refuses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVIDENCE_SECRET", "");
    vi.stubEnv("PACT_ALLOW_MEMORY_STORAGE", "true");
    await expect(pact.startSession(TEXT, { mode: "test", sellerAttack: null, client: visitor() })).rejects.toBeInstanceOf(ConfigError);
  });
});
