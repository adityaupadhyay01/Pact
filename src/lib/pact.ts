import "server-only";
import { randomUUID } from "node:crypto";
import { formatMoney } from "./canonical";
import {
  approve,
  BudgetSchema,
  ConstraintSchema,
  createContract,
  findValidApproval,
  missingForApproval,
  reviseContract,
  type Constraint,
  type ContractVersion,
  type Requirements,
} from "./contract";
import { appendEvent, verifyChain, type EvidenceEvent } from "./evidence";
import { AiError, geminiChoose, geminiConfigured, geminiExtract, geminiIntent, geminiModel } from "./ai";
import { groundIntent, SUPPORTED_CURRENCIES, type RawIntent } from "./intent";
import { catalogFacts, groundFacts, snapshot, type AgentClaim, type Facts } from "./facts";
import { detectInjectionInText } from "./injection";
import { CatalogError, type ProductRecord } from "./catalog/types";
import { channel3Configured, productChannel3, searchChannel3 } from "./catalog/channel3";
import { searchTestStore } from "./catalog/testStore";
import { testChoose, testExtract, testIntent } from "./heuristics";
import { applyAttack, ATTACK_INFO, type SellerAttack } from "./seller-mode";
import { createSnapshot, verifyOrder } from "./order-verify";
import { captureOrder, createOrder, getOrder, PayPalError, paypalMode, simulateBuyerApproval } from "./paypal";
import { receiptKeyMode, sign as signReceipt, verify as verifyReceipt } from "./receipt";
import type { CheckoutQuote } from "./quote";
import { evaluate } from "./rules";
import { hit, LIMITS } from "./ratelimit";
import {
  loadSession,
  OutdatedSessionError,
  saveSession,
  SESSION_TTL_DAYS,
  storageMode,
  type Mode,
  type ServiceName,
  type ServiceStatus,
  type Session,
  type Verified,
} from "./store";

export class PactError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

const BUYER = "demo-buyer";
/** How many other products PACT verifies besides the agent's pick, in live mode. */
const LIVE_ALTERNATIVES = 2;

const CHANGE_NAMES: Record<string, string> = { product: "the product", budget: "the budget", requirements: "a must-have" };

function log(s: Session, e: Parameters<typeof appendEvent>[1]) {
  s.events = appendEvent(s.events, e);
}

function setService(s: Session, name: ServiceName, state: ServiceStatus["state"], detail: string) {
  s.services[name] = { state, detail, at: new Date().toISOString() };
}

const current = (s: Session): ContractVersion => s.contracts[s.contracts.length - 1];

function requireApprovedContract(s: Session): ContractVersion {
  const c = current(s);
  if (!findValidApproval(c, s.approvals)) {
    throw new PactError(409, "Confirm your requirements first.");
  }
  return c;
}

function requireUnpaid(s: Session) {
  if (s.order?.status === "COMPLETED") {
    throw new PactError(409, "This order is already paid, so it can't be changed. Start over to buy something else.");
  }
}

async function getSession(id: string): Promise<Session> {
  let s: Session | null;
  try {
    s = await loadSession(id);
  } catch (err) {
    if (err instanceof OutdatedSessionError) throw new PactError(410, `${err.message} Please start again.`, "OUTDATED");
    throw err;
  }
  if (!s) throw new PactError(404, "This purchase is no longer available. Please start again.", "NOT_FOUND");
  return s;
}

/** AI is required for live verification. No silent fallback: refuse with a clear reason. */
function aiFailure(err: unknown): PactError {
  if (err instanceof AiError) {
    return new PactError(503, `AI unavailable: ${err.message} PACT won't check a purchase without it.`, "AI_UNAVAILABLE");
  }
  return err instanceof PactError ? err : new PactError(500, (err as Error).message);
}

function catalogFailure(err: unknown): PactError {
  if (err instanceof CatalogError) {
    return new PactError(err.kind === "rate_limited" ? 429 : 503, `Product search unavailable: ${err.message}`, "CATALOG_UNAVAILABLE");
  }
  return err instanceof PactError ? err : new PactError(500, (err as Error).message);
}

const isTest = (s: Session) => s.mode === "test" || s.sellerAttack !== null;

// ------------------------------------------------------------------ 1. request → requirements

export async function startSession(
  text: string,
  opts: { mode: Mode; sellerAttack: SellerAttack | null; client: string },
) {
  const requestText = text.trim().replace(/\s+/g, " ").slice(0, 600);
  if (requestText.length < 5) throw new PactError(400, "Describe what you want to buy.");
  // Live checks spend Gemini and Channel3 quota; test-store checks don't, so they get their own looser bucket.
  const limit = opts.mode === "live" ? LIMITS.perClient : LIMITS.perClientTest;
  if (!(await hit(`start:${opts.mode}:${opts.client}`, limit.limit, limit.window))) {
    throw new PactError(429, "Too many checks from this browser. Please wait a few minutes.", "RATE_LIMITED");
  }

  let raw: RawIntent;
  let engine: "gemini" | "test";
  if (opts.mode === "test") {
    raw = testIntent(requestText);
    engine = "test";
  } else {
    if (!geminiConfigured()) {
      throw new PactError(503, "AI unavailable: Gemini isn't configured on this server, so PACT can't read your request.", "AI_UNAVAILABLE");
    }
    if (!(await hit("ai:global", LIMITS.aiPerMinute.limit, LIMITS.aiPerMinute.window))) {
      throw new PactError(429, "PACT is busy right now (AI rate limit). Please try again in a minute.", "RATE_LIMITED");
    }
    try {
      raw = await geminiIntent(requestText);
    } catch (err) {
      throw aiFailure(err);
    }
    engine = "gemini";
  }

  const outcome = groundIntent(raw, requestText);
  if (!outcome.ok) {
    const testHint = opts.mode === "test" ? " The test store only understands laptop requests." : "";
    throw new PactError(422, outcome.message + testHint, outcome.reason === "not_shopping" ? "NOT_SHOPPING" : "NOT_UNDERSTOOD");
  }

  const contract = createContract(outcome.requirements, requestText);
  const now = new Date();
  const s: Session = {
    v: 2,
    id: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString(),
    mode: opts.mode,
    sellerAttack: opts.sellerAttack,
    requestText,
    intent: { engine, dropped: outcome.dropped, notes: outcome.notes },
    contracts: [contract],
    approvals: [],
    discovery: null,
    agent: null,
    verification: null,
    services: {},
    snapshot: null,
    order: null,
    events: [],
  };
  setService(s, "ai", engine === "gemini" ? "live" : "test", engine === "gemini" ? `Gemini (${geminiModel()})` : "Test-store reader (no AI)");

  if (isTest(s)) {
    log(s, {
      type: "TEST_MODE",
      actor: "pact",
      summary: [
        s.mode === "test" ? "TEST: using PACT's test store of fictional laptops." : null,
        s.sellerAttack ? `TEST: Seller Mode is on (${ATTACK_INFO[s.sellerAttack].title}).` : null,
      ]
        .filter(Boolean)
        .join(" "),
      data: { mode: s.mode, sellerAttack: s.sellerAttack },
      sources: [{ kind: "pact", ref: "test-mode" }],
    });
  }
  log(s, {
    type: "REQUEST_RECEIVED",
    actor: "buyer",
    summary: "You described what you want.",
    data: { text: requestText },
    sources: [{ kind: "buyer", ref: "request text" }],
  });
  log(s, {
    type: "CONTRACT_CREATED",
    actor: "pact",
    summary: `PACT wrote up your requirements (version 1)${engine === "gemini" ? ", read by Gemini" : ""}.`,
    data: { version: 1, hash: contract.hash, requirements: outcome.requirements, dropped: outcome.dropped },
    sources: [{ kind: "pact", ref: `contract:${contract.hash}` }],
  });
  await saveSession(s);
  return view(s);
}

export async function approveContract(id: string, contractHash: string) {
  const s = await getSession(id);
  requireUnpaid(s);
  const c = current(s);
  if (c.hash !== contractHash) throw new PactError(409, "These requirements changed. Review the latest version.");
  const missing = missingForApproval(c.requirements);
  if (missing.includes("budget")) throw new PactError(409, "Add your maximum price first.", "NEEDS_BUDGET");
  if (!findValidApproval(c, s.approvals)) {
    s.approvals.push(approve(c, BUYER));
    log(s, {
      type: "CONTRACT_APPROVED",
      actor: "buyer",
      summary: `You confirmed your requirements (version ${c.version}).`,
      data: { version: c.version, hash: c.hash },
      sources: [{ kind: "buyer", ref: `contract:${c.hash}` }],
    });
    await saveSession(s);
  }
  return view(s);
}

/** Buyer edits: a new budget, or an updated list of requirements. */
export async function revise(
  id: string,
  patch: { budget?: { max: number; currency?: string } | null; constraints?: unknown[] },
) {
  const s = await getSession(id);
  requireUnpaid(s);
  const prev = current(s);
  const next: Requirements = structuredClone(prev.requirements) as Requirements;

  if (patch.budget !== undefined) {
    if (patch.budget === null) next.budget = null;
    else {
      const currency = (patch.budget.currency ?? prev.requirements.budget?.currency ?? "").toUpperCase();
      if (!SUPPORTED_CURRENCIES.includes(currency)) throw new PactError(400, "Choose a supported currency for the budget.");
      const unchanged = prev.requirements.budget && prev.requirements.budget.max === patch.budget.max && prev.requirements.budget.currency === currency;
      next.budget = unchanged
        ? prev.requirements.budget
        : BudgetSchema.parse({ max: patch.budget.max, currency, scope: "item_price", origin: "edited", userQuote: "" });
    }
  }
  if (patch.constraints !== undefined) {
    const list = (patch.constraints as unknown[]).map((c) => ConstraintSchema.parse(c));
    const before = new Map(prev.requirements.constraints.map((c) => [c.id, c]));
    next.constraints = list.map((c): Constraint => {
      const old = before.get(c.id);
      const same = old && old.value === c.value && old.unit === c.unit && old.operator === c.operator && old.mandatory === c.mandatory;
      return same ? old : { ...c, origin: "edited", userQuote: old?.userQuote ?? "" };
    });
  }

  const { contract, criticalChanges } = reviseContract(prev, next);
  if (contract.hash === prev.hash) return view(s);
  const wasApproved = Boolean(findValidApproval(prev, s.approvals));
  s.contracts.push(contract);
  s.discovery = null;
  s.agent = null;
  s.verification = null;
  s.snapshot = null;
  s.order = null;
  log(s, {
    type: "CONTRACT_REVISED",
    actor: "buyer",
    summary: `You changed your requirements (version ${contract.version}).`,
    data: { version: contract.version, hash: contract.hash, parentHash: prev.hash, criticalChanges, patch },
    sources: [{ kind: "pact", ref: `contract:${contract.hash}` }],
  });
  if (wasApproved && criticalChanges.length === 0) {
    s.approvals.push({ ...approve(contract, BUYER), carriedFromHash: prev.hash });
    log(s, {
      type: "CONTRACT_APPROVED",
      actor: "pact",
      summary: "Your confirmation still stands: only nice-to-haves changed.",
      data: { version: contract.version, hash: contract.hash, carriedFromHash: prev.hash },
      sources: [{ kind: "pact", ref: `contract:${contract.hash}` }],
    });
  } else if (wasApproved) {
    log(s, {
      type: "APPROVAL_INVALIDATED",
      actor: "pact",
      summary: `Please confirm again: you changed ${criticalChanges.map((f) => CHANGE_NAMES[f] ?? f).join(", ")}.`,
      data: { criticalChanges },
      sources: [{ kind: "pact", ref: `contract:${contract.hash}` }],
    });
  }
  await saveSession(s);
  return view(s);
}

// ------------------------------------------------------------------ 2. discovery

function conditionsFor(req: Requirements): ("new" | "used")[] {
  const c = req.constraints.find((x) => x.mandatory && x.attribute === "condition" && x.operator === "eq");
  if (c?.value === "new") return ["new"];
  if (c && /used|refurb|pre-?owned/i.test(c.value ?? "")) return ["used"];
  return ["new", "used"];
}

export async function discover(id: string) {
  const s = await getSession(id);
  requireUnpaid(s);
  const contract = requireApprovedContract(s);
  const req = contract.requirements;
  if (!req.budget) throw new PactError(409, "Add your maximum price first.", "NEEDS_BUDGET");

  let candidates: ProductRecord[];
  let searchedPrices: Record<string, number> = {};
  if (s.mode === "test") {
    const results = searchTestStore();
    candidates = results.map((r) => r.record);
    searchedPrices = Object.fromEntries(results.map((r) => [r.record.id, r.listedPrice]));
    setService(s, "catalog", "test", "PACT test store (fictional laptops)");
  } else {
    if (!channel3Configured()) {
      throw new PactError(503, "Product search unavailable: Channel3 isn't configured on this server.", "CATALOG_UNAVAILABLE");
    }
    if (!(await hit("catalog:monthly", LIMITS.catalogMonthly.limit, LIMITS.catalogMonthly.window))) {
      throw new PactError(503, "Product search unavailable: this demo has used its monthly search allowance.", "CATALOG_UNAVAILABLE");
    }
    try {
      candidates = await searchChannel3({
        query: req.searchQuery,
        maxPrice: req.budget.max,
        currency: req.budget.currency,
        conditions: conditionsFor(req),
        limit: 10,
      });
    } catch (err) {
      setService(s, "catalog", "error", err instanceof CatalogError ? err.message : "Search failed");
      await saveSession(s);
      throw catalogFailure(err);
    }
    searchedPrices = Object.fromEntries(candidates.map((c) => [c.id, c.offer.price]));
    setService(s, "catalog", "live", `Channel3 catalog: ${candidates.length} result${candidates.length === 1 ? "" : "s"}`);
  }

  s.discovery = {
    contractHash: contract.hash,
    provider: s.mode === "test" ? "test-store" : "channel3",
    query: req.searchQuery,
    retrievedAt: new Date().toISOString(),
    candidates,
    searchedPrices,
  };
  s.agent = null;
  s.verification = null;
  s.snapshot = null;
  s.order = null;
  log(s, {
    type: "PRODUCTS_FOUND",
    actor: "pact",
    summary:
      candidates.length === 0
        ? `No products found for “${req.searchQuery}” within your budget.`
        : `Found ${candidates.length} product${candidates.length === 1 ? "" : "s"} for “${req.searchQuery}” (${s.mode === "test" ? "test store" : "Channel3 catalog"}).`,
    data: { provider: s.discovery.provider, query: req.searchQuery, ids: candidates.map((c) => c.id) },
    sources: [{ kind: "pact", ref: s.mode === "test" ? "test-store" : "channel3:/v1/search" }],
  });
  await saveSession(s);
  return view(s);
}

// ------------------------------------------------------------------ 3. the shopping agent

export async function select(id: string) {
  const s = await getSession(id);
  requireUnpaid(s);
  const contract = requireApprovedContract(s);
  const d = s.discovery;
  if (!d || d.contractHash !== contract.hash) throw new PactError(409, "Search for products first.");
  if (d.candidates.length === 0) throw new PactError(409, "There are no products to choose from.", "NO_PRODUCTS");
  const req = contract.requirements;

  let choice: { chosenId: string; reasons: string[]; claims: AgentClaim[]; summary: string };
  let engine: "gemini" | "test";
  if (s.mode === "test" && s.sellerAttack) {
    // Seller Mode in the test store: the test agent behaves honestly and picks the cheapest product that
    // passes every check, so the simulated seller attack is the only thing wrong with the purchase.
    const clean: ProductRecord[] = [];
    for (const p of d.candidates) {
      const v = await verifyOne(s, req, p, d.searchedPrices[p.id] ?? p.offer.price, null);
      if (v.evaluation.verdict === "PASS") clean.push(p);
    }
    const pick = clean.sort((a, b) => a.offer.price - b.offer.price)[0];
    choice = pick
      ? {
          chosenId: pick.id,
          reasons: [
            `Looked at ${d.candidates.length} listings and skipped pages that try to instruct AI agents.`,
            `Picked the cheapest listing that meets every requirement: ${pick.title}.`,
          ],
          claims: req.constraints.map((c) => ({ constraintId: c.id, value: c.value })),
          summary: `${pick.title} matches all your requirements.`,
        }
      : testChoose(req, d.candidates);
    engine = "test";
  } else if (s.mode === "test") {
    choice = testChoose(req, d.candidates);
    engine = "test";
  } else {
    if (!geminiConfigured()) throw aiFailure(new AiError("unconfigured", "Gemini isn't configured on this server."));
    try {
      choice = await geminiChoose(req, d.candidates);
    } catch (err) {
      throw aiFailure(err);
    }
    engine = "gemini";
  }
  // The agent may only pick from the real results; anything else is rejected, not trusted.
  if (!d.candidates.some((c) => c.id === choice.chosenId)) {
    throw new PactError(502, "The shopping agent picked a product that wasn't in the search results, so PACT rejected its choice. Try again.", "AGENT_INVALID");
  }
  const ids = new Set(req.constraints.map((c) => c.id));
  const claims = choice.claims.filter((c) => ids.has(c.constraintId));
  s.agent = {
    contractHash: contract.hash,
    engine,
    chosenId: choice.chosenId,
    reasons: choice.reasons.slice(0, 5),
    claims,
    summary: choice.summary.slice(0, 300),
  };
  s.verification = null;
  s.snapshot = null;
  s.order = null;
  const chosen = d.candidates.find((c) => c.id === choice.chosenId)!;
  log(s, {
    type: "AGENT_CHOSE",
    actor: "agent",
    summary: `The shopping agent chose ${chosen.title} (${formatMoney(chosen.offer.price, chosen.offer.currency)}).`,
    data: { productId: chosen.id, engine, reasons: s.agent.reasons, claims, summary: s.agent.summary },
    sources: [{ kind: "agent", ref: engine === "gemini" ? `gemini:${geminiModel()}` : "test-agent" }],
  });
  await saveSession(s);
  return view(s);
}

// ------------------------------------------------------------------ 4. PACT verification

const visibleOf = (p: ProductRecord) =>
  [p.title, p.description ?? "", ...p.keyFeatures, ...Object.entries(p.attributes).map(([k, v]) => `${k}: ${v.join(", ")}`)].join("\n");

/**
 * Verify one product independently: build and hash the evidence, read facts
 * (catalog fields first, then a separate reader that never sees the agent's
 * output), ground every quote, and let the rule engine decide.
 */
async function verifyOne(
  s: Session,
  req: Requirements,
  record: ProductRecord,
  searchedPrice: number,
  agent: { claims: AgentClaim[]; summary: string } | null,
): Promise<Verified> {
  const evidence = snapshot(record);
  const fromCatalog = catalogFacts(req.constraints, record);
  const toRead = req.constraints.filter((c) => !fromCatalog[c.id]);
  let facts: Facts = {};
  let rejected: Verified["rejected"] = [];
  let instruction: string | null = null;
  let reader: Verified["reader"] = "catalog_fields";

  if (s.mode === "test") {
    const g = groundFacts(testExtract(toRead, record), toRead, evidence.text);
    facts = g.facts;
    rejected = g.rejected;
    reader = "test";
  } else {
    const raw = await geminiExtract(toRead, evidence.text); // throws AiError → refuse
    const g = groundFacts(raw, toRead, evidence.text);
    facts = g.facts;
    rejected = g.rejected;
    instruction = g.instruction;
    reader = "gemini";
  }
  facts = { ...facts, ...fromCatalog };
  for (const c of req.constraints) if (!(c.id in facts)) facts[c.id] = null;

  const injection = detectInjectionInText(visibleOf(record), record.hiddenText, instruction);
  const evaluation = evaluate({
    requirements: req,
    product: record,
    facts,
    injection,
    searchedPrice,
    agentClaims: agent?.claims,
    agentSummary: agent?.summary,
  });
  return { productId: record.id, record, evidence, facts, rejected, injection, evaluation, reader, searchedPrice };
}

export async function verify(id: string) {
  const s = await getSession(id);
  requireUnpaid(s);
  const contract = requireApprovedContract(s);
  const req = contract.requirements;
  const d = s.discovery;
  const a = s.agent;
  if (!d || !a || a.contractHash !== contract.hash) throw new PactError(409, "Let the agent choose a product first.");
  if (s.mode === "live" && !geminiConfigured()) throw aiFailure(new AiError("unconfigured", "Gemini isn't configured on this server."));

  let subjectRecord = d.candidates.find((c) => c.id === a.chosenId)!;
  // Refresh price and availability before verifying (Channel3 caching guide; product detail is free).
  if (s.mode === "live") {
    try {
      const fresh = await productChannel3(subjectRecord.id, subjectRecord.offer.currency);
      if (fresh) subjectRecord = { ...subjectRecord, offer: fresh.offer, retrievedAt: fresh.retrievedAt };
    } catch (err) {
      console.warn("[verify] product refresh failed, using search data:", (err as Error).message);
    }
  }
  if (s.sellerAttack) {
    subjectRecord = applyAttack(subjectRecord, s.sellerAttack, req);
    log(s, {
      type: "SELLER_MODE_APPLIED",
      actor: "pact",
      summary: `TEST: Seller Mode altered a copy of ${subjectRecord.title} (${ATTACK_INFO[s.sellerAttack].title}). This is synthetic data.`,
      data: { productId: subjectRecord.id, attack: s.sellerAttack },
      sources: [{ kind: "pact", ref: "seller-mode" }],
    });
  }

  let subject: Verified;
  try {
    subject = await verifyOne(s, req, subjectRecord, d.searchedPrices[subjectRecord.id] ?? subjectRecord.offer.price, a);
  } catch (err) {
    throw aiFailure(err);
  }

  // Alternatives: in the test store PACT checks everything; live, the cheapest few within budget.
  const others = d.candidates
    .filter((c) => c.id !== subject.productId)
    .sort((x, y) => x.offer.price - y.offer.price);
  const pool = s.mode === "test" ? others : others.filter((c) => !req.budget || c.offer.price <= req.budget.max).slice(0, LIVE_ALTERNATIVES);
  const alternatives: Verified[] = [];
  const unchecked: string[] = [];
  for (const rec of pool) {
    try {
      alternatives.push(await verifyOne(s, req, rec, d.searchedPrices[rec.id] ?? rec.offer.price, null));
    } catch (err) {
      if (err instanceof AiError) unchecked.push(rec.id);
      else throw err;
    }
  }
  const recommended =
    subject.evaluation.verdict === "PASS"
      ? null
      : (alternatives.filter((x) => x.evaluation.verdict === "PASS").sort((x, y) => x.evaluation.totalCents - y.evaluation.totalCents)[0] ?? null);

  s.verification = {
    contractHash: contract.hash,
    subject,
    alternatives,
    recommendedId: recommended?.productId ?? null,
    unchecked,
  };
  s.snapshot = null;
  s.order = null;
  const issues = subject.evaluation.checks.filter((c) => c.status !== "pass").map((c) => c.label);
  log(s, {
    type: "PRODUCT_VERIFIED",
    actor: "pact",
    summary: `PACT checked ${subject.record.title}: ${subject.evaluation.verdict}${issues.length ? ` (${issues.join(", ").toLowerCase()})` : ""}. Also checked ${alternatives.length} alternative${alternatives.length === 1 ? "" : "s"}.`,
    data: {
      productId: subject.productId,
      evidenceHash: subject.evidence.hash,
      verdict: subject.evaluation.verdict,
      reader: subject.reader,
      alternatives: alternatives.map((x) => ({ id: x.productId, verdict: x.evaluation.verdict, evidenceHash: x.evidence.hash })),
      unchecked,
    },
    sources: [{ kind: "listing", ref: `${subject.record.provider}:${subject.productId}` }],
  });
  await saveSession(s);
  return view(s);
}

function findVerified(s: Session, productId: string): Verified | null {
  const v = s.verification;
  if (!v) return null;
  if (v.subject.productId === productId) return v.subject;
  return v.alternatives.find((x) => x.productId === productId) ?? null;
}

// ------------------------------------------------------------------ 5. purchase approval

export async function approvePurchase(id: string, productId: string, acknowledgedFlags: string[]) {
  const s = await getSession(id);
  const contract = requireApprovedContract(s);
  // One paid purchase per session: a second "Buy" must be a deliberate new session, never an accidental double payment.
  if (s.order?.status === "COMPLETED") {
    throw new PactError(409, "You've already paid for this order. Start over to buy something else.");
  }
  if (!s.verification || s.verification.contractHash !== contract.hash) {
    throw new PactError(409, "Run the check again for your current requirements.");
  }
  const verified = findVerified(s, productId);
  if (!verified) throw new PactError(404, "PACT hasn't checked that product.");

  // Refresh price and availability right before approval; a change is caught here, not after payment.
  let record = verified.record;
  if (record.provider === "channel3") {
    try {
      const fresh = await productChannel3(record.id, record.offer.currency);
      if (fresh && (fresh.offer.price !== record.offer.price || fresh.offer.availability !== record.offer.availability || fresh.offer.currency !== record.offer.currency)) {
        record = { ...record, offer: fresh.offer, retrievedAt: fresh.retrievedAt };
      }
    } catch (err) {
      throw new PactError(503, `Couldn't confirm the current price with Channel3 (${(err as Error).message}). Nothing was charged. Try again.`, "CATALOG_UNAVAILABLE");
    }
  }
  const isSubject = s.verification.subject.productId === productId;
  const ev = evaluate({
    requirements: contract.requirements,
    product: record,
    facts: verified.facts,
    injection: verified.injection,
    searchedPrice: verified.record.offer.price,
    agentClaims: isSubject ? s.agent?.claims : undefined,
    agentSummary: isSubject ? s.agent?.summary : undefined,
  });
  if (record !== verified.record) {
    // Keep the verified record in sync with what the buyer is approving.
    verified.record = record;
    verified.evidence = snapshot(record);
    verified.evaluation = ev;
  }
  if (ev.verdict === "BLOCK") {
    await saveSession(s);
    throw new PactError(422, "PACT blocked this purchase: it breaks your requirements.", "BLOCKED");
  }
  const flags = ev.checks.filter((c) => c.status === "flag").map((c) => c.id);
  const missing = flags.filter((f) => !acknowledgedFlags.includes(f));
  if (missing.length) {
    await saveSession(s);
    throw new PactError(422, "Review and confirm each issue that needs your OK first.", "NEEDS_ACK");
  }

  const quote: CheckoutQuote = {
    currency: record.offer.currency,
    itemPrice: record.offer.price,
    shipping: 0,
    tax: 0,
    fees: [],
    recurring: null,
  };
  s.snapshot = createSnapshot(contract, record.id, quote, flags, new Date(), {
    evidenceHash: verified.evidence.hash,
    seller: record.offer.domain,
  });
  s.order = null;
  log(s, {
    type: "PURCHASE_APPROVED",
    actor: "buyer",
    summary: `You confirmed ${record.title} for ${formatMoney(record.offer.price, record.offer.currency)} (item price; shipping and tax not included).`,
    data: {
      snapshotHash: s.snapshot.hash,
      contractHash: contract.hash,
      productId: record.id,
      evidenceHash: verified.evidence.hash,
      seller: record.offer.domain,
      quote,
      verdict: ev.verdict,
      acknowledgedFlags: flags,
    },
    sources: [{ kind: "listing", ref: `${record.provider}:${record.id}` }],
  });
  await saveSession(s);
  return view(s);
}

/**
 * Serialises payment actions per session inside one server process, so a
 * double-click or two tabs can't run two captures at the same time. Across
 * serverless instances, PayPal's idempotency key covers the same case.
 */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

const sim = (s: Session) => (s.simOrders ??= {});

/** The seller's checkout creates the PayPal order. PACT does not trust it. */
export async function createPaypalOrder(id: string) {
  return withLock(id, async () => {
    const s = await getSession(id);
    requireApprovedContract(s);
    if (!s.snapshot) throw new PactError(409, "Confirm the purchase first.");
    if (s.order?.status === "COMPLETED" && s.order.paypal?.customId === s.snapshot.hash) {
      throw new PactError(409, "This purchase has already been paid.");
    }
    const verified = findVerified(s, s.snapshot.listingId);
    if (!verified) throw new PactError(409, "Run the check again before paying.");
    // The (simulated) merchant creates the order. Seller Mode may make it ask for more than approved.
    const approved = s.snapshot.quote;
    const sent = verified.record.orderPriceOverride ? { ...approved, itemPrice: verified.record.orderPriceOverride } : approved;
    let order;
    try {
      order = await createOrder(sent, verified.productId, s.snapshot.hash, verified.record.title, sim(s));
    } catch (err) {
      throw paypalFailure(err, "PayPal couldn't start the payment. Nothing was charged. Please try again.");
    }
    // Same approval, same order: a retry returns the existing order and logs nothing new.
    if (s.order?.id === order.id && s.order.status !== "CANCELLED" && s.order.status !== "DECLINED") {
      return { orderId: order.id, session: view(s) };
    }
    s.order = { id: order.id, status: order.status, captureId: null, verification: null, paypal: null };
    setService(s, "payments", paypalMode() === "sandbox" ? "live" : "simulated", paypalMode() === "sandbox" ? "PayPal Sandbox" : "PayPal simulator (no sandbox keys)");
    log(s, {
      type: "PAYPAL_ORDER_CREATED",
      actor: "paypal",
      summary: `The seller created PayPal order ${order.id}${paypalMode() === "simulated" ? " (demo)" : ""}.`,
      data: { orderId: order.id, mode: paypalMode() },
      sources: [{ kind: "paypal", ref: `order:${order.id}` }],
    });
    await saveSession(s);
    return { orderId: order.id, session: view(s) };
  });
}

export async function simulateApproval(id: string, orderId: string, opts: { decline?: boolean } = {}) {
  if (paypalMode() !== "simulated") throw new PactError(400, "Only available in simulated mode.");
  return withLock(id, async () => {
    const s = await getSession(id);
    if (s.order?.id !== orderId || !simulateBuyerApproval(orderId, sim(s), opts)) {
      throw new PactError(404, "Order not found");
    }
    await saveSession(s);
    return view(s);
  });
}

/** The buyer closed the PayPal window without paying. */
export async function cancelPayment(id: string, orderId: string) {
  return withLock(id, async () => {
    const s = await getSession(id);
    if (!s.order || s.order.id !== orderId) throw new PactError(404, "Order not found");
    if (s.order.status === "COMPLETED") return view(s);
    if (s.order.status !== "CANCELLED") {
      s.order = { ...s.order, status: "CANCELLED" };
      log(s, {
        type: "PAYPAL_CANCELLED",
        actor: "buyer",
        summary: "You closed PayPal before paying. Nothing was charged.",
        data: { orderId },
        sources: [{ kind: "paypal", ref: `order:${orderId}` }],
      });
      await saveSession(s);
    }
    return view(s);
  });
}

/** Turn a PayPal error into a message a buyer can act on. */
function paypalFailure(err: unknown, fallback: string): PactError {
  if (err instanceof PactError) return err;
  if (err instanceof PayPalError) {
    if (err.issue === "ORDER_NOT_APPROVED" || err.issue === "PAYER_ACTION_REQUIRED") {
      return new PactError(409, "Please approve the payment in the PayPal window first.");
    }
    if (err.issue === "AUTH_FAILED") return new PactError(502, "PACT couldn't connect to PayPal. Nothing was charged.");
    if (err.issue === "RESOURCE_NOT_FOUND") return new PactError(404, "PayPal couldn't find this order. Nothing was charged.");
  }
  console.error(err);
  return new PactError(502, fallback);
}

export async function capture(id: string, orderId: string) {
  return withLock(id, async () => {
    const s = await getSession(id);
    requireApprovedContract(s);
    if (!s.snapshot || !s.order || s.order.id !== orderId) throw new PactError(409, "No approved purchase for this order.");
    if (s.snapshot.contractHash !== current(s).hash) throw new PactError(409, "The contract changed after approval.");

    // Already paid: return the original result instead of charging again.
    if (s.order.status === "COMPLETED" && s.order.captureId) return view(s);

    // Fetch the order from PayPal itself and compare with what the buyer approved.
    let order;
    try {
      order = await getOrder(orderId, sim(s));
    } catch (err) {
      throw paypalFailure(err, "PACT couldn't read the order from PayPal. Nothing was charged. Please try again.");
    }
    const verification = verifyOrder(s.snapshot, order);
    s.order = { ...s.order, status: order.status, verification, paypal: order };

    if (!verification.ok) {
      const failed = verification.checks.filter((c) => c.status !== "pass");
      log(s, {
        type: "PAYPAL_CAPTURE_BLOCKED",
        actor: "pact",
        summary: `Payment stopped: the PayPal order didn't match what you confirmed (${failed.map((c) => c.label.toLowerCase()).join(", ")}). No money moved.`,
        data: { orderId, order, failed },
        sources: [{ kind: "paypal", ref: `order:${orderId}` }],
      });
      await saveSession(s);
      return view(s);
    }

    log(s, {
      type: "PAYPAL_ORDER_VERIFIED",
      actor: "pact",
      summary: `PACT checked PayPal order ${orderId}: it matches what you confirmed, to the cent.`,
      data: { orderId, order, snapshotHash: s.snapshot.hash },
      sources: [{ kind: "paypal", ref: `order:${orderId}` }],
    });

    let cap;
    try {
      const attempt = s.events.filter(
        (e) => e.type === "PAYPAL_PAYMENT_FAILED" && (e.data as { orderId?: string }).orderId === orderId,
      ).length;
      cap = await captureOrder(orderId, sim(s), attempt);
    } catch (err) {
      if (err instanceof PayPalError && err.issue === "INSTRUMENT_DECLINED") {
        s.order = { ...s.order, status: "DECLINED" };
        log(s, {
          type: "PAYPAL_PAYMENT_FAILED",
          actor: "paypal",
          summary: "PayPal declined the payment method. Nothing was charged.",
          data: { orderId, issue: err.issue },
          sources: [{ kind: "paypal", ref: `order:${orderId}` }],
        });
        await saveSession(s);
        return view(s);
      }
      const failure = paypalFailure(err, "PayPal couldn't complete the payment. Nothing was charged. Please try again.");
      if (failure.status !== 409) {
        log(s, {
          type: "PAYPAL_PAYMENT_FAILED",
          actor: "paypal",
          summary: "PayPal couldn't complete the payment. Nothing was charged.",
          data: { orderId, issue: err instanceof PayPalError ? err.issue : null },
          sources: [{ kind: "paypal", ref: `order:${orderId}` }],
        });
        await saveSession(s);
      }
      throw failure;
    }

    s.order = { ...s.order, status: cap.status, captureId: cap.captureId };
    setService(s, "payments", paypalMode() === "sandbox" ? "live" : "simulated", paypalMode() === "sandbox" ? "PayPal Sandbox: payment captured" : "PayPal simulator: payment captured");
    log(s, {
      type: "PAYPAL_CAPTURED",
      actor: "paypal",
      summary: `Payment complete: ${formatMoney(Number(order.total), order.currency)}.`,
      data: { orderId, captureId: cap.captureId, status: cap.status, amount: order.total, currency: order.currency },
      sources: [{ kind: "paypal", ref: `capture:${cap.captureId}` }],
    });
    await saveSession(s);
    return view(s);
  });
}

export async function getView(id: string) {
  return view(await getSession(id));
}

/** Verify a receipt, e.g. one downloaded and edited by a judge. Needs the server's signature. */
export function verifyReceiptPackage(sessionId: string, events: EvidenceEvent[], signature: string) {
  return verifyReceipt(sessionId, events, signature);
}

function view(s: Session) {
  const c = current(s);
  return {
    v: s.v,
    id: s.id,
    mode: s.mode,
    sellerAttack: s.sellerAttack,
    isTest: isTest(s),
    requestText: s.requestText,
    intent: s.intent,
    contract: c,
    contracts: s.contracts,
    approved: Boolean(findValidApproval(c, s.approvals)),
    missing: missingForApproval(c.requirements),
    approvals: s.approvals,
    discovery: s.discovery,
    agent: s.agent,
    verification: s.verification,
    services: s.services,
    snapshot: s.snapshot,
    order: s.order,
    events: s.events,
    chain: verifyChain(s.events),
    receipt: { signature: signReceipt(s.id, s.events), key: receiptKeyMode(), test: isTest(s) },
    env: { paypal: paypalMode(), ai: geminiConfigured(), catalog: channel3Configured(), storage: storageMode() },
  };
}
export type SessionView = ReturnType<typeof view>;
