"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { BadgeCheck, ShieldX } from "lucide-react";
import { ChecksList } from "./Checks";
import { findVerified } from "./flow";
import { Button, Details, focusSoon, Step, type StepControl, money, shortHash } from "./ui";
import { ApiError, sessionAction, type SessionView } from "./api";

/** Server answers that mean the product or the approval changed: reload the session before showing the reason. */
const RELOAD_ON = new Set(["EVIDENCE_CHANGED", "APPROVAL_EXPIRED", "APPROVAL_INVALID", "BLOCKED", "PRODUCT_GONE"]);

export interface AppConfig {
  paypal: "sandbox" | "simulated" | "unavailable";
  paypalClientId: string | null;
  ai: boolean;
  aiModel: string | null;
  catalog: boolean;
  catalogRegion?: string;
  storage: string;
  configOk?: boolean;
  problems?: string[];
}

export function Checkout({
  control,
  session,
  selectedId,
  config,
  setSession,
  onError,
}: {
  control: StepControl;
  session: SessionView;
  selectedId: string;
  config: AppConfig;
  setSession: (s: SessionView) => void;
  onError: (msg: string) => void;
}) {
  const result = findVerified(session, selectedId);
  const [acks, setAcks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (!result) return null;

  const product = result.record;
  const q = { currency: product.offer.currency, itemPrice: product.offer.price };
  // Every "check first" item needs the buyer's OK, including an agent claim the listing doesn't back up.
  const flags = result.evaluation.checks.filter((c) => c.status === "flag");
  const snap = session.snapshot?.listingId === selectedId ? session.snapshot : null;
  const order = snap ? session.order : null;
  const captured = order?.status === "COMPLETED";
  const blocked = Boolean(order?.verification && !order.verification.ok && !captured);
  const declined = order?.status === "DECLINED";
  const cancelled = order?.status === "CANCELLED";
  const pending = Boolean(order && !captured && !blocked && order.captureId && order.status !== "CAPTURE_MISMATCH");
  const mismatch = order?.status === "CAPTURE_MISMATCH";
  const simulated = config.paypal === "simulated";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      // When the product or the approval changed on the server, show the fresh state, then the reason.
      if (e instanceof ApiError && e.code && RELOAD_ON.has(e.code)) {
        const fresh = await fetch(`/api/session/${encodeURIComponent(session.id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (fresh) setSession(fresh as SessionView);
        if (e.code === "EVIDENCE_CHANGED") setAcks([]);
      }
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approvePurchase = () =>
    run(async () => {
      // The price shown is sent only so the server can refuse if it changed; the server's fresh price is what counts.
      setSession(
        await sessionAction(session.id, "purchase", {
          productId: selectedId,
          acknowledgedFlags: acks,
          expectedPrice: q.itemPrice,
          expectedCurrency: q.currency,
        }),
      );
      focusSoon("pay-button");
    });

  /** Simulator only: walks the same server path a PayPal popup would, with the outcome the buyer picks. */
  const paySimulated = (outcome: "pay" | "decline" | "cancel") =>
    run(async () => {
      const { orderId } = await sessionAction<{ orderId: string }>(session.id, "order");
      if (outcome === "cancel") {
        setSession(await sessionAction(session.id, "cancel", { orderId }));
        focusSoon("pay-button");
        return;
      }
      await sessionAction(session.id, "sim-approve", { orderId, decline: outcome === "decline" });
      setSession(await sessionAction(session.id, "capture", { orderId }));
      focusSoon(outcome === "pay" ? "payment-result" : "pay-button");
    });

  const total = snap ? snap.quote.itemPrice : q.itemPrice;
  const orderTotal = order?.paypal ? Number(order.paypal.total) : null;

  // Where the buyer is in the payment, in words (never colour alone).
  const stages = [
    { label: "Confirm the price", done: Boolean(snap) },
    { label: "Approve in PayPal", done: Boolean(captured || blocked) },
    { label: "PACT checks the PayPal order, then charges", done: Boolean(captured || blocked) },
  ];

  return (
    <Step
      control={control}
      title="Checkout"
      subtitle="Approve the verified purchase. PayPal payment only happens after you do, and PACT re-checks the amount first."
      next="You pay in PayPal. PACT then compares the PayPal order with the price you approved, to the cent, and only then takes the payment."
    >
      <div className="grid gap-8 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* The order, as a receipt-style ledger */}
        <section aria-labelledby="order-title">
          <h3 id="order-title" className="eyebrow text-muted">
            Your order
          </h3>
          <p className="mt-2 text-xl font-semibold tracking-[-0.01em] text-ink">{product.title}</p>
          <p className="text-sm text-muted">Sold on {product.offer.domain}</p>
          {(session.isTest || product.synthetic) && (
            <p className="eyebrow mt-2 inline-block border border-flag-line bg-flag-soft px-1.5 py-0.5 text-flag">
              TEST purchase: fictional or altered product
            </p>
          )}

          <dl className="mt-5 border-t border-ink text-sm">
            <Row label="Condition" value={product.offer.condition ?? "Not stated"} />
            <Row label="Availability" value={product.offer.availability.replace(/([a-z])([A-Z])/g, "$1 $2")} />
            <div className="flex items-baseline justify-between gap-4 border-t border-ink pt-3">
              <dt className="font-semibold text-ink">Item price</dt>
              <dd className="num font-mono text-2xl font-medium text-ink">{money(total, q.currency)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted">
            PACT verifies the item price only. Shipping, tax and the merchant&apos;s own checkout total are not verified.
            This demo charges the item price through PayPal Sandbox; it does not place an order with the merchant.
          </p>

          {!snap && flags.length > 0 && (
            <fieldset className="mt-6 border-l-2 border-flag-icon bg-flag-soft px-4 py-3">
              <legend className="sr-only">Before you continue, please confirm</legend>
              <p aria-hidden="true" className="eyebrow text-flag">Before you continue, please confirm</p>
              <ul className="mt-2 space-y-2">
                {flags.map((f) => (
                  <li key={f.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-[var(--color-ink)]"
                        checked={acks.includes(f.id)}
                        onChange={(e) => setAcks(e.target.checked ? [...acks, f.id] : acks.filter((a) => a !== f.id))}
                      />
                      <span>
                        I&apos;m OK with this. <span className="font-medium">{f.label}:</span> {f.detail}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}

          {!snap && (
            <Button
              id="approve-purchase"
              className="mt-6 w-full"
              onClick={approvePurchase}
              loading={busy}
              disabled={flags.some((f) => !acks.includes(f.id))}
            >
              <BadgeCheck className="h-4 w-4" /> Confirm {money(total, q.currency)} and continue
            </Button>
          )}
        </section>

        {/* The payment */}
        <section aria-labelledby="payment-title">
          <h3 id="payment-title" className="eyebrow text-muted">
            Payment
          </h3>
          <ol className="mt-3 border-t border-line">
            {stages.map((st, i) => (
              <li key={st.label} className="flex items-center gap-3 border-b border-line py-2.5 text-sm">
                <span
                  className={`num flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px] ${
                    st.done ? "border border-pass-line bg-pass-soft text-pass" : "border border-line-strong text-faint"
                  }`}
                  aria-hidden="true"
                >
                  {st.done ? "✓" : i + 1}
                </span>
                <span className={st.done ? "text-ink" : "text-muted"}>{st.label}</span>
                <span className="sr-only">{st.done ? "(done)" : "(not yet)"}</span>
              </li>
            ))}
          </ol>

          {!snap && (
            <p className="mt-4 text-sm text-muted">Confirm the price first. Then you&apos;ll pay with PayPal.</p>
          )}

          {snap && !captured && !blocked && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-ink-2">
                You confirmed <span className="num font-mono font-medium">{money(total, q.currency)}</span>. Now pay
                with PayPal.
              </p>
              {declined && (
                <p role="status" className="border-l-2 border-flag-icon bg-flag-soft px-3 py-2 text-sm text-ink">
                  PayPal declined that payment method. Nothing was charged. Try again with a different card or account.
                </p>
              )}
              {cancelled && (
                <p role="status" className="border-l-2 border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink">
                  You closed PayPal before paying. Nothing was charged. You can try again whenever you&apos;re ready.
                </p>
              )}
              {pending && (
                <p role="status" className="border-l-2 border-flag-icon bg-flag-soft px-3 py-2 text-sm text-ink">
                  PayPal hasn&apos;t completed this payment yet (status {order?.status}). PACT doesn&apos;t count it as paid.
                </p>
              )}
              {mismatch && (
                <p role="alert" className="border-l-2 border-block bg-block-soft px-3 py-2 text-sm text-ink">
                  PayPal reported a captured amount that differs from the price you approved. PACT does not treat this as a
                  verified payment. See the receipt below.
                </p>
              )}
              {config.paypal === "sandbox" && config.paypalClientId ? (
                <>
                  <PayPalButtons
                    clientId={config.paypalClientId}
                    currency={q.currency}
                    sessionId={session.id}
                    setSession={setSession}
                    onError={onError}
                  />
                  <p className="text-xs text-muted">
                    <span className="eyebrow mr-1 text-flag">Sandbox</span>
                    PayPal test money. This isn&apos;t the merchant&apos;s checkout and no order is placed with the store.
                  </p>
                </>
              ) : simulated ? (
                <>
                  <p className="eyebrow inline-block border border-flag-line bg-flag-soft px-1.5 py-0.5 text-flag">
                    SIMULATED PayPal: no PayPal account or real payment involved
                  </p>
                  <Button id="pay-button" variant="paypal" className="w-full py-3 text-base" onClick={() => paySimulated("pay")} loading={busy}>
                    Pay with PayPal
                  </Button>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Try other PayPal outcomes">
                    <Button variant="secondary" onClick={() => paySimulated("decline")} disabled={busy}>
                      Simulate a declined card
                    </Button>
                    <Button variant="secondary" onClick={() => paySimulated("cancel")} disabled={busy}>
                      Simulate closing PayPal
                    </Button>
                  </div>
                </>
              ) : (
                <p role="alert" className="border-l-2 border-block bg-block-soft px-3 py-2 text-sm text-ink">
                  Payments are unavailable: PayPal Sandbox isn&apos;t configured on this server. Nothing can be charged.
                </p>
              )}
            </div>
          )}

          {(captured || blocked) && order?.verification && (
            <motion.div
              id="payment-result"
              tabIndex={-1}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="mt-4 space-y-4 outline-none"
            >
              <div
                className={`border-l-4 px-4 py-3 ${captured ? "border-pass bg-pass-soft" : "border-block bg-block-soft"}`}
              >
                {captured ? (
                  <>
                    <p className="flex items-center gap-2 text-lg font-semibold text-pass">
                      <BadgeCheck className="h-5 w-5" /> Payment complete
                    </p>
                    <p className="mt-1 text-sm text-ink-2">
                      PayPal charged exactly the {money(total, q.currency)} you confirmed. Your receipt is below.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="flex items-center gap-2 text-lg font-semibold text-block">
                      <ShieldX className="h-5 w-5" /> Payment stopped. No money moved.
                    </p>
                    <p className="mt-1 text-sm text-ink-2">
                      {orderTotal !== null && orderTotal !== total
                        ? `The seller asked PayPal for ${money(orderTotal, q.currency)}, but you confirmed ${money(total, q.currency)}. PACT caught the difference before any money was taken.`
                        : "The PayPal order didn't match what you confirmed, so PACT stopped it."}
                    </p>
                    <a href="#step-decision" className="mt-2 inline-block text-sm font-medium text-ink underline underline-offset-2">
                      Choose a different product
                    </a>
                  </>
                )}
              </div>

              {/* The amount check, side by side */}
              <dl className="grid grid-cols-2 border-y border-line text-sm">
                <div className="border-r border-line py-3 pr-4">
                  <dt className="eyebrow text-faint">You confirmed</dt>
                  <dd className="num mt-1 font-mono text-lg text-ink">{money(total, q.currency)}</dd>
                </div>
                <div className="py-3 pl-4">
                  <dt className="eyebrow text-faint">PayPal order</dt>
                  <dd className={`num mt-1 font-mono text-lg ${captured ? "text-ink" : "text-block"}`}>
                    {orderTotal !== null ? money(orderTotal, order.paypal?.currency ?? q.currency) : "—"}
                  </dd>
                </div>
              </dl>

              {!captured && <ChecksList checks={order.verification.checks} onlyIssues />}
              <Details summary="Show what PACT checked with PayPal">
                <ChecksList checks={order.verification.checks} showPasses />
                <p className="mt-2 text-xs text-muted">
                  PayPal order <span className="num font-mono">{order.id}</span>
                  {order.captureId && (
                    <>
                      {" "}· payment <span className="num font-mono">{order.captureId}</span>
                    </>
                  )}
                  {snap && (
                    <>
                      {" "}· approval <span className="num font-mono">{shortHash(snap.hash)}</span>
                    </>
                  )}
                </p>
              </Details>
            </motion.div>
          )}
        </section>
      </div>
    </Step>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2">
      <dt className={warn ? "font-medium text-flag" : "text-muted"}>
        {label}
        {warn && <span className="sr-only"> (not in the listing)</span>}
      </dt>
      <dd className={`num text-right font-mono ${warn ? "text-flag" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

type PayPalNamespace = {
  Buttons: (opts: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; close?: () => void };
};

function PayPalButtons({
  clientId,
  currency,
  sessionId,
  setSession,
  onError,
}: {
  clientId: string;
  currency: string;
  sessionId: string;
  setSession: (s: SessionView) => void;
  onError: (m: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${currency}&intent=capture&components=buttons`;
    const w = window as unknown as { paypal?: PayPalNamespace };
    const render = () => {
      if (!ref.current || !w.paypal) return;
      ref.current.innerHTML = "";
      w.paypal
        .Buttons({
          style: { layout: "vertical", shape: "rect", label: "paypal" },
          createOrder: async () => {
            const { orderId } = await sessionAction<{ orderId: string }>(sessionId, "order");
            return orderId;
          },
          onApprove: async (data: { orderID: string }) => {
            setSession(await sessionAction(sessionId, "capture", { orderId: data.orderID }));
            focusSoon("payment-result");
          },
          onCancel: async (data: { orderID: string }) => {
            setSession(await sessionAction(sessionId, "cancel", { orderId: data.orderID }));
            focusSoon("paypal-buttons");
          },
          onError: () => onError("PayPal ran into a problem. Nothing was charged. Please try again."),
        })
        .render(ref.current)
        .then(() => setReady(true));
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[data-pact-paypal]`);
    if (existing && w.paypal) {
      render();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.pactPaypal = "1";
    s.onload = render;
    s.onerror = () => onError("Could not load the PayPal SDK.");
    document.body.appendChild(s);
  }, [clientId, currency, sessionId, setSession, onError]);

  return (
    <div>
      <div ref={ref} id="paypal-buttons" tabIndex={-1} className="outline-none" />
      {!ready && <p className="text-sm text-muted">Loading PayPal…</p>}
      <p className="mt-2 text-xs text-muted">PayPal test mode: log in with a sandbox buyer account.</p>
    </div>
  );
}
