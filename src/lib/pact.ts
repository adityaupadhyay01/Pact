import "server-only";
import { randomUUID } from "node:crypto";
import { formatMoney } from "./canonical";
import {
  approve,
  createContract,
  findValidApproval,
  reviseContract,
  RequirementsSchema,
  type ContractVersion,
  type Requirements,
} from "./contract";
import { appendEvent, verifyChain, type EvidenceEvent } from "./evidence";
import { aiEnabled, classifyInjection, extractFacts, parseRequest } from "./ai";
import { detectInjection, hiddenSegments, mergeClassifier, visibleText } from "./injection";
import { getListing, LISTINGS, sellerOrderQuote, type Listing } from "./marketplace";
import { createSnapshot, verifyOrder } from "./order-verify";
import { captureOrder, createOrder, getOrder, PayPalError, paypalMode, simulateBuyerApproval } from "./paypal";
import { receiptKeyMode, sign as signReceipt, verify as verifyReceipt } from "./receipt";
import { quoteTotal } from "./quote";
import { evaluate } from "./rules";
import { pickProtected, runUnprotectedAgent } from "./agents";
import { loadSession, saveSession, storageMode, type ListingResult, type Session } from "./store";

export class PactError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const BUYER = "demo-buyer";

const FIELD_NAMES: Record<string, string> = {
  ramGbMin: "RAM",
  storageGbMin: "storage",
  warrantyMonthsMin: "warranty",
  condition: "condition",
  maxTotal: "budget",
  currency: "currency",
  category: "product type",
};

function log(s: Session, e: Parameters<typeof appendEvent>[1]) {
  s.events = appendEvent(s.events, e);
}

const current = (s: Session): ContractVersion => s.contracts[s.contracts.length - 1];

function requireApprovedContract(s: Session): ContractVersion {
  const c = current(s);
  if (!findValidApproval(c, s.approvals)) {
    throw new PactError(409, "The current contract version has not been approved by the buyer.");
  }
  return c;
}

async function getSession(id: string): Promise<Session> {
  const s = await loadSession(id);
  if (!s) throw new PactError(404, "Session not found");
  return s;
}

export async function startSession(text: string) {
  const requestText = text.trim().slice(0, 1000);
  if (requestText.length < 5) throw new PactError(400, "Describe what you want to buy.");
  const { requirements, engine } = await parseRequest(requestText);
  const contract = createContract(requirements, requestText);
  const s: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    requestText,
    parseEngine: engine,
    contracts: [contract],
    approvals: [],
    search: null,
    snapshot: null,
    order: null,
    events: [],
  };
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
    summary: "PACT wrote up your rules (version 1).",
    data: { version: 1, hash: contract.hash, requirements },
    sources: [{ kind: "pact", ref: `contract:${contract.hash}` }],
  });
  await saveSession(s);
  return view(s);
}

export async function approveContract(id: string, contractHash: string) {
  const s = await getSession(id);
  const c = current(s);
  if (c.hash !== contractHash) {
    throw new PactError(409, "This contract version is outdated. Review the latest version.");
  }
  if (!findValidApproval(c, s.approvals)) {
    s.approvals.push(approve(c, BUYER));
    log(s, {
      type: "CONTRACT_APPROVED",
      actor: "buyer",
      summary: `You confirmed your rules (version ${c.version}).`,
      data: { version: c.version, hash: c.hash },
      sources: [{ kind: "buyer", ref: `contract:${c.hash}` }],
    });
    await saveSession(s);
  }
  return view(s);
}

export async function revise(id: string, patch: Partial<Requirements>) {
  const s = await getSession(id);
  if (s.order?.status === "COMPLETED") {
    throw new PactError(409, "This order is already paid, so it can't be changed. Start over to buy something else.");
  }
  const prev = current(s);
  const parsedPatch = RequirementsSchema.partial().parse(patch);
  const { contract, criticalChanges } = reviseContract(prev, parsedPatch);
  if (contract.hash === prev.hash) return view(s);
  const wasApproved = Boolean(findValidApproval(prev, s.approvals));
  s.contracts.push(contract);
  s.search = null;
  s.snapshot = null;
  s.order = null;
  log(s, {
    type: "CONTRACT_REVISED",
    actor: "buyer",
    summary: `You changed your rules (version ${contract.version}).`,
    data: { version: contract.version, hash: contract.hash, parentHash: prev.hash, criticalChanges, patch: parsedPatch },
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
      summary: `Please confirm again: you changed ${criticalChanges.map((f) => FIELD_NAMES[f] ?? f).join(", ")}.`,
      data: { criticalChanges },
      sources: [{ kind: "pact", ref: `contract:${contract.hash}` }],
    });
  }
  await saveSession(s);
  return view(s);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function analyseListing(req: Requirements, l: Listing): Promise<ListingResult> {
  const visible = visibleText(l.html);
  const { facts, rejected, engine } = await extractFacts(visible);
  let injection = detectInjection(l.html);
  // The classifier only looks at hidden text, where attacks live; keeps API usage low.
  const hidden = hiddenSegments(l.html).join("\n");
  if (aiEnabled() && hidden) injection = mergeClassifier(injection, await classifyInjection(hidden));
  const evaluation = evaluate({ requirements: req, facts, listedPrice: l.listedPrice, quote: l.checkout, injection });
  return { listingId: l.id, facts, rejectedFacts: rejected, injection, evaluation, engine };
}

export async function search(id: string) {
  const s = await getSession(id);
  if (s.order?.status === "COMPLETED") {
    throw new PactError(409, "This order is already paid, so it can't be changed. Start over to buy something else.");
  }
  const contract = requireApprovedContract(s);
  const req = contract.requirements;

  const results = await mapLimit(LISTINGS, 4, (l) => analyseListing(req, l));

  // PACT-protected recommendation, re-evaluated with the agent's own claim.
  const ranked = results.map((r) => ({ listing: getListing(r.listingId)!, facts: r.facts, evaluation: r.evaluation }));
  const { recommended, claim } = pickProtected(ranked);
  if (recommended && claim) {
    const r = results.find((x) => x.listingId === recommended.listing.id)!;
    r.evaluation = evaluate({
      requirements: req,
      facts: r.facts,
      listedPrice: recommended.listing.listedPrice,
      quote: recommended.listing.checkout,
      injection: r.injection,
      agentClaim: claim,
    });
  }

  // Baseline agent, audited by PACT after the fact.
  const naive = runUnprotectedAgent(req, LISTINGS);
  let unprotected: NonNullable<Session["search"]>["unprotected"] = null;
  if (naive) {
    const r = results.find((x) => x.listingId === naive.listing.id)!;
    unprotected = {
      listingId: naive.listing.id,
      reasoning: naive.reasoning,
      claimSummary: naive.claim.summary,
      evaluation: evaluate({
        requirements: req,
        facts: r.facts,
        listedPrice: naive.listing.listedPrice,
        quote: naive.listing.checkout,
        injection: r.injection,
        agentClaim: naive.claim,
      }),
    };
  }

  s.search = { contractHash: contract.hash, results, recommendedId: recommended?.listing.id ?? null, unprotected };
  s.snapshot = null;
  s.order = null;

  const counts = { PASS: 0, FLAG: 0, BLOCK: 0 };
  for (const r of results) counts[r.evaluation.verdict]++;
  log(s, {
    type: "AGENT_SEARCH",
    actor: "agent",
    summary: `Checked ${results.length} laptops: ${counts.PASS} match, ${counts.FLAG} need a look, ${counts.BLOCK} blocked.`,
    data: {
      contractHash: contract.hash,
      verdicts: Object.fromEntries(results.map((r) => [r.listingId, r.evaluation.verdict])),
      recommendedId: recommended?.listing.id ?? null,
      unprotectedPick: naive?.listing.id ?? null,
      injectionsDetected: results.filter((r) => r.injection.severity !== "none").map((r) => r.listingId),
    },
    sources: LISTINGS.map((l) => ({ kind: "listing" as const, ref: l.url })),
  });
  await saveSession(s);
  return view(s);
}

export async function approvePurchase(id: string, listingId: string, acknowledgedFlags: string[]) {
  const s = await getSession(id);
  const contract = requireApprovedContract(s);
  // One paid purchase per session: a second "Buy" must be a deliberate new session, never an accidental double payment.
  if (s.order?.status === "COMPLETED") {
    throw new PactError(409, "You've already paid for this order. Start over to buy something else.");
  }
  if (!s.search || s.search.contractHash !== contract.hash) {
    throw new PactError(409, "Run the search again for the current contract.");
  }
  const listing = getListing(listingId);
  const result = s.search.results.find((r) => r.listingId === listingId);
  if (!listing || !result) throw new PactError(404, "Listing not found");

  // Re-evaluate from scratch in code; never trust a verdict sent by the client.
  const ev = evaluate({
    requirements: contract.requirements,
    facts: result.facts,
    listedPrice: listing.listedPrice,
    quote: listing.checkout,
    injection: result.injection,
  });
  if (ev.verdict === "BLOCK") {
    throw new PactError(422, "PACT blocked this purchase: it breaks the agreed contract.");
  }
  const flags = ev.checks.filter((c) => c.status === "flag").map((c) => c.id);
  const missing = flags.filter((f) => !acknowledgedFlags.includes(f));
  if (missing.length) {
    throw new PactError(422, `Review and acknowledge each flagged issue first: ${missing.join(", ")}.`);
  }

  s.snapshot = createSnapshot(contract, listing.id, listing.checkout, flags);
  s.order = null;
  log(s, {
    type: "PURCHASE_APPROVED",
    actor: "buyer",
    summary: `You confirmed ${listing.title} for ${formatMoney(quoteTotal(listing.checkout), listing.checkout.currency)}.`,
    data: {
      snapshotHash: s.snapshot.hash,
      contractHash: contract.hash,
      listingId: listing.id,
      quote: listing.checkout,
      verdict: ev.verdict,
      acknowledgedFlags: flags,
      facts: result.facts,
    },
    sources: [
      { kind: "listing", ref: listing.url },
      { kind: "checkout", ref: `${listing.url}/checkout` },
    ],
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
    const listing = getListing(s.snapshot.listingId)!;
    let order;
    try {
      order = await createOrder(sellerOrderQuote(listing), listing.id, s.snapshot.hash, listing.title, sim(s));
    } catch (err) {
      throw paypalFailure(err, "PayPal couldn't start the payment. Nothing was charged. Please try again.");
    }
    // Same approval, same order: a retry returns the existing order and logs nothing new.
    if (s.order?.id === order.id && s.order.status !== "CANCELLED" && s.order.status !== "DECLINED") {
      return { orderId: order.id, session: view(s) };
    }
    s.order = { id: order.id, status: order.status, captureId: null, verification: null, paypal: null };
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
    id: s.id,
    requestText: s.requestText,
    parseEngine: s.parseEngine,
    contract: c,
    contracts: s.contracts,
    approved: Boolean(findValidApproval(c, s.approvals)),
    approvals: s.approvals,
    search: s.search,
    snapshot: s.snapshot,
    order: s.order,
    events: s.events,
    chain: verifyChain(s.events),
    receipt: { signature: signReceipt(s.id, s.events), key: receiptKeyMode() },
    env: { paypal: paypalMode(), ai: aiEnabled(), storage: storageMode() },
  };
}
export type SessionView = ReturnType<typeof view>;
