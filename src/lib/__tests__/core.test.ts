import { inspect } from "../inspector";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonical";
import { approve, createContract, findValidApproval, reviseContract, verifyContractHash, type Requirements } from "../contract";
import { appendEvent, eventHash, GENESIS, signReceipt, verifyChain, verifyReceipt, type EvidenceEvent } from "../evidence";
import { snapshot } from "../facts";
import { testChoose, testExtract, testIntent } from "../heuristics";
import { groundIntent, type RawIntent } from "../intent";
import { compare } from "../rules";
import { convert, parseNumber } from "../units";
import { searchTestStore, testStoreRecord } from "../catalog/testStore";
import { normalise } from "../catalog/channel3-normalise";
import { applyAttack } from "../seller-mode";
import type { ProductRecord } from "../catalog/types";

const now = new Date("2026-11-11T10:00:00Z");
const REQUEST = "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";

function requirementsFor(text: string): Requirements {
  const out = groundIntent(testIntent(text), text);
  if (!out.ok) throw new Error(out.message);
  return out.requirements;
}
const req = requirementsFor(REQUEST);

/** The real Inspector, with the test-store reader as the extractor (what PACT runs in test mode). */
function verifyRecord(r: Requirements, p: ProductRecord, searchedPrice = p.offer.price) {
  return inspect({ requirements: r, record: p, extraction: testExtract(r.constraints, p), searchedPrice }).evaluation;
}

// ------------------------------------------------------------------ intent grounding

describe("intent grounding: nothing is invented", () => {
  const base: RawIntent = {
    isShoppingRequest: true,
    product: "dark chocolate bar",
    productQuote: "dark chocolate bar",
    searchQuery: "70% dark chocolate bar",
    budget: null,
    constraints: [],
    clarificationQuestion: null,
  };
  const text = "I want a 70% dark chocolate bar under $5, ideally organic";

  it("keeps a budget only when the buyer stated it, with the number in their words", () => {
    const ok = groundIntent({ ...base, budget: { max: 5, currency: "usd", userQuote: "under $5" } }, text);
    expect(ok.ok && ok.requirements.budget).toMatchObject({ max: 5, currency: "USD", scope: "item_price" });

    const invented = groundIntent({ ...base, budget: { max: 1000, currency: "USD", userQuote: "under $5" } }, text);
    expect(invented.ok && invented.requirements.budget).toBeNull();

    const noBudget = groundIntent(base, "I want a 70% dark chocolate bar");
    expect(noBudget.ok && noBudget.requirements.budget).toBeNull();
    expect(noBudget.ok && noBudget.notes.join(" ")).toMatch(/No budget/);
  });

  it("drops requirements that aren't in the buyer's words", () => {
    const out = groundIntent(
      {
        ...base,
        constraints: [
          { label: "Cocoa content", attribute: "cocoa_percent", operator: "gte", value: "70", unit: "%", mandatory: true, userQuote: "70%" },
          { label: "Weight", attribute: "weight", operator: "gte", value: "100", unit: "g", mandatory: true, userQuote: "100g bar" },
          { label: "Cocoa", attribute: "cocoa_percent", operator: "gte", value: "85", unit: "%", mandatory: true, userQuote: "70%" },
          { label: "Organic", attribute: "organic", operator: "present", value: null, unit: null, mandatory: false, userQuote: "ideally organic" },
        ],
      },
      text,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.requirements.constraints.map((c) => c.attribute)).toEqual(["cocoa_percent", "organic"]);
    expect(out.requirements.constraints[1].mandatory).toBe(false);
    expect(out.dropped.map((d) => d.what)).toEqual(["Weight", "Cocoa"]);
  });

  it("refuses non-shopping text and unclear products", () => {
    expect(groundIntent({ ...base, isShoppingRequest: false }, "asdf qwer").ok).toBe(false);
    expect(groundIntent({ ...base, productQuote: "headphones" }, text).ok).toBe(false);
  });

  it("test-store reader: laptop request, no invented budget", () => {
    expect(req.budget).toMatchObject({ max: 900, currency: "USD" });
    expect(req.constraints.map((c) => `${c.attribute} ${c.operator} ${c.value} ${c.unit ?? ""}`.trim())).toEqual([
      "ram gte 16 GB",
      "storage gte 1 TB",
      "warranty gte 2 year",
      "condition eq new",
    ]);
    expect(requirementsFor("Find me a laptop with 16GB RAM").budget).toBeNull();
    expect(groundIntent(testIntent("asdf qwer zxcv"), "asdf qwer zxcv").ok).toBe(false);
  });
});

// ------------------------------------------------------------------ contract

describe("contract versioning", () => {
  const v1 = createContract(req, REQUEST, now);

  it("is sealed, immutable and tamper-evident", () => {
    expect(verifyContractHash(v1)).toBe(true);
    expect(() => {
      (v1.requirements as { product: string }).product = "x";
    }).toThrow();
    const forged = { ...v1, requirements: { ...v1.requirements, budget: { ...v1.requirements.budget!, max: 5000 } } };
    expect(verifyContractHash(forged)).toBe(false);
    expect(findValidApproval(forged, [approve(v1, "buyer", now)])).toBeNull();
  });

  it("needs re-approval when the budget or a must-have changes, not for a preference", () => {
    const a1 = approve(v1, "buyer", now);
    const budget = reviseContract(v1, { ...req, budget: { ...req.budget!, max: 950, origin: "edited", userQuote: "" } }, now);
    expect(budget.criticalChanges).toEqual(["budget"]);
    expect(findValidApproval(budget.contract, [a1])).toBeNull();
    const pref = reviseContract(
      v1,
      { ...req, constraints: [...req.constraints, { id: "c9", label: "Light", attribute: "weight", operator: "lte", value: "1.5", unit: "kg", mandatory: false, origin: "edited", userQuote: "" }] },
      now,
    );
    expect(pref.criticalChanges).toEqual([]);
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

// ------------------------------------------------------------------ units and comparison

describe("units and comparison", () => {
  it("converts and parses", () => {
    expect(convert(1, "TB", "GB")).toBe(1000);
    expect(convert(2, "years", "month")).toBeCloseTo(24);
    expect(convert(1, "kg", "%")).toBeNull();
    expect(parseNumber("70% cocoa")).toEqual({ value: 70, unit: "%" });
    expect(parseNumber("two-year warranty")).toEqual({ value: 2, unit: "year" });
  });

  const c = (operator: "gte" | "lte" | "eq" | "excludes", value: string, unit: string | null = null) => ({
    id: "c1", label: "x", attribute: "x", operator, value, unit, mandatory: true, origin: "request" as const, userQuote: "",
  });
  const f = (value: string, unit: string | null = null) => ({ constraintId: "c1", value, unit, quote: value, source: "extracted" as const });

  it("compares across units and wording", () => {
    expect(compare(c("gte", "70", "%"), f("72", "%")).result).toBe("met");
    expect(compare(c("gte", "70", "%"), f("45%")).result).toBe("not_met");
    expect(compare(c("gte", "1", "TB"), f("512", "GB")).result).toBe("not_met");
    expect(compare(c("gte", "24", "months"), f("2", "year")).result).toBe("met");
    expect(compare(c("lte", "200", "g"), f("1", "kg")).result).toBe("not_met");
    expect(compare(c("gte", "5", "kg"), f("5", "%")).result).toBe("unknown");
    expect(compare(c("eq", "black"), f("Matte Black")).result).toBe("met");
    expect(compare(c("excludes", "nuts"), f("nut-free")).result).toBe("met");
    expect(compare(c("excludes", "nuts"), f("contains nuts")).result).toBe("not_met");
  });
});

// ------------------------------------------------------------------ rule engine on the test store (regression)

describe("rule engine on the test store", () => {
  // Item-price scope: fees, tax and subscriptions at checkout are not verified (by design).
  const expected: Record<string, { verdict: string; failing: string[] }> = {
    "L-101": { verdict: "PASS", failing: [] },
    "L-102": { verdict: "BLOCK", failing: ["c3", "c4"] },
    "L-103": { verdict: "BLOCK", failing: ["budget", "injection"] },
    "L-104": { verdict: "PASS", failing: [] },
    "L-105": { verdict: "FLAG", failing: ["price-drift"] },
    "L-106": { verdict: "PASS", failing: [] },
    "L-107": { verdict: "FLAG", failing: ["c3"] },
    "L-108": { verdict: "BLOCK", failing: ["c1"] },
    "L-109": { verdict: "BLOCK", failing: ["currency"] },
    "L-110": { verdict: "PASS", failing: [] },
    "L-111": { verdict: "BLOCK", failing: ["budget"] },
    "L-112": { verdict: "BLOCK", failing: ["c2"] },
  };
  const store = searchTestStore(now);

  for (const [id, exp] of Object.entries(expected)) {
    it(`${id} → ${exp.verdict}`, () => {
      const { record, listedPrice } = store.find((x) => x.record.id === id)!;
      const e = verifyRecord(req, record, listedPrice);
      expect(e.verdict).toBe(exp.verdict);
      expect(e.checks.filter((c) => c.status !== "pass").map((c) => c.id).sort()).toEqual([...exp.failing].sort());
    });
  }

  it("a missing fact is flagged, never passed", () => {
    const p = { ...testStoreRecord("L-101", now)!, description: "A laptop." };
    const e = verifyRecord(req, p);
    expect(e.verdict).toBe("FLAG");
  });

  it("evidence is labelled synthetic and hashed", () => {
    const s1 = snapshot(testStoreRecord("L-101", now)!);
    expect(s1.synthetic?.kind).toBe("test-store");
    expect(s1.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the test-store agent follows the planted instruction", () => {
    expect(testChoose(req, store.map((x) => x.record)).chosenId).toBe("L-103");
  });
});

// ------------------------------------------------------------------ Seller Mode

describe("Seller Mode", () => {
  const base = testStoreRecord("L-101", now)!;

  it("hidden instructions are blocked", () => {
    const p = applyAttack(base, "hidden_instruction", req);
    expect(p.synthetic?.kind).toBe("seller-mode");
    expect(verifyRecord(req, p).verdict).toBe("BLOCK");
    expect(base.hiddenText).toEqual([]); // the original is untouched
  });

  it("fine print that contradicts a must-have is blocked", () => {
    const e = verifyRecord(req, applyAttack(base, "spec_contradiction", req));
    expect(e.verdict).toBe("BLOCK");
    expect(e.checks.find((c) => c.id === "c1")?.status).toBe("block");
  });

  it("price inflation is only visible at PayPal", () => {
    const p = applyAttack(base, "price_inflation", req);
    expect(verifyRecord(req, p).verdict).toBe("PASS");
    expect(p.orderPriceOverride).toBeGreaterThan(p.offer.price);
  });
});

// ------------------------------------------------------------------ Channel3 normaliser

describe("Channel3 normaliser (shape from the documented Product schema, not a recorded response)", () => {
  it("picks the cheapest in-stock offer and keeps no offer URL", () => {
    const rec = normalise(
      {
        id: "p1",
        title: "Dark Chocolate 70%",
        description: "Rich dark chocolate with 70% cocoa.",
        brands: [{ id: "b", name: "Acme" }],
        key_features: ["70% cocoa", "100 g bar"],
        structured_attributes: { color: ["brown"], empty: [] },
        offers: [
          { url: "https://a.example/p", domain: "a.example", price: { price: 4.5, currency: "USD" }, availability: "InStock", condition: "new" },
          { url: "https://b.example/p", domain: "b.example", price: { price: 3.9, currency: "USD" }, availability: "OutOfStock", condition: "new" },
          { url: "https://c.example/p", domain: "c.example", price: { price: 4.1, currency: "usd" }, availability: "InStock", condition: "new" },
        ],
      },
      now,
    )!;
    expect(rec.offer).toEqual({ domain: "c.example", price: 4.1, currency: "USD", availability: "InStock", condition: "new" });
    expect(rec.attributes).toEqual({ color: ["brown"] });
    expect(JSON.stringify(rec)).not.toContain("https://");
    expect(normalise({ id: "x", title: "No offers", offers: [] })).toBeNull();
  });
});

// ------------------------------------------------------------------ evidence chain and signed receipts

describe("evidence chain", () => {
  const build = () => {
    let chain: EvidenceEvent[] = [];
    chain = appendEvent(chain, { type: "REQUEST_RECEIVED", actor: "buyer", summary: "req", data: { REQUEST }, sources: [] }, now);
    chain = appendEvent(chain, { type: "CONTRACT_APPROVED", actor: "buyer", summary: "ok", data: { v: 1 }, sources: [] }, now);
    chain = appendEvent(chain, { type: "PAYPAL_CAPTURED", actor: "paypal", summary: "paid", data: { amount: "872.24" }, sources: [] }, now);
    return chain;
  };

  it("verifies an untouched chain and catches edits and removals", () => {
    expect(verifyChain(build()).valid).toBe(true);
    const edited = build();
    edited[1] = { ...edited[1], data: { v: 2 } };
    expect(verifyChain(edited)).toMatchObject({ valid: false, brokenAt: 1 });
    const removed = build();
    removed.splice(1, 1);
    expect(verifyChain(removed).valid).toBe(false);
  });

  it("a forgery that recomputes every hash fails the server signature", () => {
    const secret = "test-secret";
    const c = build();
    const sig = signReceipt(secret, "s1", c);
    expect(verifyReceipt(secret, "s1", c, sig).valid).toBe(true);
    const forged = structuredClone(c);
    (forged[2].data as { amount: string }).amount = "1.00";
    let prev = GENESIS;
    for (const e of forged) {
      e.prevHash = prev;
      const { hash: _old, ...body } = e;
      void _old;
      e.hash = eventHash(body);
      prev = e.hash;
    }
    expect(verifyChain(forged).valid).toBe(true);
    expect(verifyReceipt(secret, "s1", forged, sig)).toMatchObject({ valid: false, signatureValid: false });
    expect(verifyReceipt(secret, "s2", c, sig).valid).toBe(false);
  });
});
