import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonical";
import {
  approve,
  createContract,
  findValidApproval,
  reviseContract,
  verifyContractHash,
  type Requirements,
} from "../contract";
import { appendEvent, eventHash, GENESIS, signReceipt, verifyChain, verifyReceipt, type EvidenceEvent } from "../evidence";
import { groundFacts } from "../facts";
import { extractFactsHeuristic, parseRequestHeuristic } from "../heuristics";
import { detectInjection, visibleText } from "../injection";
import { getListing, LISTINGS } from "../marketplace";
import { evaluate } from "../rules";
import { runUnprotectedAgent, pickProtected } from "../agents";

const REQUEST =
  "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";
const req: Requirements = parseRequestHeuristic(REQUEST);
const now = new Date("2026-11-10T10:00:00Z");

describe("request parsing", () => {
  it("turns the buyer's words into requirements", () => {
    expect(req).toEqual({
      category: "laptop",
      ramGbMin: 16,
      storageGbMin: 1000,
      warrantyMonthsMin: 24,
      condition: "new",
      maxTotal: 900,
      currency: "USD",
      preferences: [],
    });
  });
});

describe("canonical JSON", () => {
  it("is independent of key order", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("contract versioning", () => {
  const v1 = createContract(req, REQUEST, now);

  it("is sealed and immutable", () => {
    expect(verifyContractHash(v1)).toBe(true);
    expect(() => {
      (v1.requirements as { maxTotal: number }).maxTotal = 5000;
    }).toThrow();
  });

  it("detects tampering with a sealed contract", () => {
    const forged = { ...v1, requirements: { ...v1.requirements, maxTotal: 5000 } };
    expect(verifyContractHash(forged)).toBe(false);
    expect(findValidApproval(forged, [approve(v1, "buyer", now)])).toBeNull();
  });

  it("requires re-approval when a critical field changes", () => {
    const a1 = approve(v1, "buyer", now);
    expect(findValidApproval(v1, [a1])).not.toBeNull();
    const { contract: v2, criticalChanges } = reviseContract(v1, { maxTotal: 950 }, now);
    expect(v2.version).toBe(2);
    expect(v2.parentHash).toBe(v1.hash);
    expect(criticalChanges).toEqual(["maxTotal"]);
    expect(findValidApproval(v2, [a1])).toBeNull();
  });

  it("reports no critical change for preference edits", () => {
    const { criticalChanges } = reviseContract(v1, { preferences: ["light weight"] }, now);
    expect(criticalChanges).toEqual([]);
  });
});

describe("fact grounding", () => {
  it("drops facts whose quote is not in the source", () => {
    const { facts, rejected } = groundFacts(
      {
        ramGb: { value: 16, quote: "16GB RAM" },
        storageGb: null,
        warrantyMonths: { value: 24, quote: "2-year warranty" },
        condition: null,
      },
      "Laptop with 16GB RAM. 1-year limited warranty.",
    );
    expect(facts.ramGb?.value).toBe(16);
    expect(facts.warrantyMonths).toBeNull();
    expect(rejected).toHaveLength(1);
  });
});

describe("injection detection", () => {
  it("catches the hidden instruction in L-103", () => {
    const r = detectInjection(getListing("L-103")!.html);
    expect(r.severity).toBe("high");
    expect(r.findings.every((f) => f.location === "hidden")).toBe(true);
    expect(r.findings.map((f) => f.rule)).toContain("budget-manipulation");
  });

  it("keeps hidden text out of what the buyer sees", () => {
    expect(visibleText(getListing("L-103")!.html)).not.toMatch(/ignore previous/i);
  });

  it("does not flag clean listings", () => {
    expect(detectInjection(getListing("L-101")!.html).severity).toBe("none");
  });
});

function evalListing(id: string) {
  const l = getListing(id)!;
  const vis = visibleText(l.html);
  const { facts } = groundFacts(extractFactsHeuristic(vis), vis);
  return evaluate({
    requirements: req,
    facts,
    listedPrice: l.listedPrice,
    quote: l.checkout,
    injection: detectInjection(l.html),
  });
}

describe("rule engine on the marketplace", () => {
  const expected: Record<string, { verdict: string; failing: string[] }> = {
    "L-101": { verdict: "PASS", failing: [] },
    "L-102": { verdict: "BLOCK", failing: ["warranty", "condition"] },
    "L-103": { verdict: "BLOCK", failing: ["injection", "budget"] },
    "L-104": { verdict: "FLAG", failing: ["fees"] },
    "L-105": { verdict: "BLOCK", failing: ["budget", "price-drift"] },
    "L-106": { verdict: "PASS", failing: [] },
    "L-107": { verdict: "FLAG", failing: ["warranty"] },
    "L-108": { verdict: "BLOCK", failing: ["ram"] },
    "L-109": { verdict: "BLOCK", failing: ["currency"] },
    "L-110": { verdict: "FLAG", failing: ["recurring"] },
    "L-111": { verdict: "BLOCK", failing: ["budget"] },
    "L-112": { verdict: "BLOCK", failing: ["storage"] },
  };

  for (const [id, exp] of Object.entries(expected)) {
    it(`${id} → ${exp.verdict}`, () => {
      const e = evalListing(id);
      expect(e.verdict).toBe(exp.verdict);
      const failing = e.checks.filter((c) => c.status !== "pass").map((c) => c.id).sort();
      expect(failing).toEqual([...exp.failing].sort());
    });
  }

  it("flags missing facts instead of passing them", () => {
    const l = getListing("L-101")!;
    const e = evaluate({
      requirements: req,
      facts: { ramGb: null, storageGb: null, warrantyMonths: null, condition: null },
      listedPrice: l.listedPrice,
      quote: l.checkout,
      injection: { severity: "none", findings: [] },
    });
    expect(e.verdict).toBe("FLAG");
  });
});

describe("agents", () => {
  it("the unprotected agent gets steered by the injected listing", () => {
    const r = runUnprotectedAgent(req, LISTINGS)!;
    expect(r.listing.id).toBe("L-103");
  });

  it("the protected agent recommends the cheapest PASS", () => {
    const candidates = LISTINGS.map((l) => {
      const vis = visibleText(l.html);
      const { facts } = groundFacts(extractFactsHeuristic(vis), vis);
      return { listing: l, facts, evaluation: evalListing(l.id) };
    });
    expect(pickProtected(candidates).recommended?.listing.id).toBe("L-101");
  });

  it("PACT flags the unprotected agent's false claims", () => {
    // Without the injected listing, it falls back to the cheapest keyword match.
    const r = runUnprotectedAgent(req, LISTINGS.filter((l) => l.id !== "L-103"))!;
    expect(r.listing.id).toBe("L-112");
    const vis = visibleText(r.listing.html);
    const e = evaluate({
      requirements: req,
      facts: groundFacts(extractFactsHeuristic(vis), vis).facts,
      listedPrice: r.listing.listedPrice,
      quote: r.listing.checkout,
      injection: detectInjection(r.listing.html),
      agentClaim: r.claim,
    });
    expect(e.verdict).toBe("BLOCK");
    expect(e.checks.find((c) => c.id === "agent-claim")?.status).toBe("flag");
  });
});

describe("evidence chain", () => {
  const build = () => {
    let chain: EvidenceEvent[] = [];
    chain = appendEvent(chain, { type: "REQUEST_RECEIVED", actor: "buyer", summary: "req", data: { REQUEST }, sources: [] }, now);
    chain = appendEvent(chain, { type: "CONTRACT_APPROVED", actor: "buyer", summary: "ok", data: { v: 1 }, sources: [] }, now);
    chain = appendEvent(chain, { type: "PAYPAL_CAPTURED", actor: "paypal", summary: "paid", data: { id: "X" }, sources: [] }, now);
    return chain;
  };

  it("verifies an untouched chain", () => {
    expect(verifyChain(build()).valid).toBe(true);
  });

  it("detects an edited event", () => {
    const chain = build();
    chain[1] = { ...chain[1], data: { v: 2 } };
    const v = verifyChain(chain);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it("detects a removed event", () => {
    const chain = build();
    chain.splice(1, 1);
    expect(verifyChain(chain).valid).toBe(false);
  });
});

describe("signed receipts", () => {
  const secret = "test-secret";
  const chain = () => {
    let c: EvidenceEvent[] = [];
    c = appendEvent(c, { type: "REQUEST_RECEIVED", actor: "buyer", summary: "req", data: {}, sources: [] }, now);
    c = appendEvent(c, { type: "PAYPAL_CAPTURED", actor: "paypal", summary: "paid", data: { amount: "872.24" }, sources: [] }, now);
    return c;
  };

  it("accepts an untouched receipt", () => {
    const c = chain();
    expect(verifyReceipt(secret, "s1", c, signReceipt(secret, "s1", c)).valid).toBe(true);
  });

  it("rejects a forgery that recomputes every hash", () => {
    const c = chain();
    const sig = signReceipt(secret, "s1", c);
    const forged = structuredClone(c);
    (forged[1].data as { amount: string }).amount = "1.00";
    let prev = GENESIS;
    for (const e of forged) {
      e.prevHash = prev;
      const { hash: _old, ...body } = e;
      void _old;
      e.hash = eventHash(body);
      prev = e.hash;
    }
    expect(verifyChain(forged).valid).toBe(true); // the hash chain alone is fooled
    const r = verifyReceipt(secret, "s1", forged, sig);
    expect(r.valid).toBe(false);
    expect(r.signatureValid).toBe(false);
  });

  it("rejects a receipt moved to another session or signed with another key", () => {
    const c = chain();
    expect(verifyReceipt(secret, "s2", c, signReceipt(secret, "s1", c)).valid).toBe(false);
    expect(verifyReceipt(secret, "s1", c, signReceipt("other", "s1", c)).valid).toBe(false);
    expect(verifyReceipt(secret, "s1", c, "not-a-signature").valid).toBe(false);
  });
});
