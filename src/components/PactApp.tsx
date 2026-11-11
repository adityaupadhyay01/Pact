"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import {
  AlertTriangle,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  FlaskConical,
  Loader2,
  Lock,
  PlayCircle,
  RotateCcw,
  ShieldX,
  X,
} from "lucide-react";
import type { Constraint } from "@/lib/contract";
import { ATTACK_INFO, SELLER_ATTACKS, type SellerAttack } from "@/lib/seller-mode";
import { Checkout, type AppConfig } from "./Checkout";
import { ContractCard } from "./ContractCard";
import { Evidence } from "./Evidence";
import { DecisionStep, DiscoveryStep, VerificationStep } from "./FlowSteps";
import { analyse, findVerified, requirementTerms, type Analysis } from "./flow";
import {
  Button,
  Details,
  STATUS_TEXT,
  Step,
  StepMarker,
  VERDICT_LABEL,
  cn,
  focusSoon,
  money,
  stepNumber,
  type StepControl,
  type StepId,
  type StepStatus,
} from "./ui";
import { ApiError, post, sessionAction, type SessionView } from "./api";

type Mode = "live" | "test";

const LIVE_EXAMPLES = [
  "Dark chocolate bar with at least 70% cocoa, under $10",
  "Waterproof trail running shoes, men's size 10, under $130",
  "A new laptop with 16GB RAM and a 1TB SSD, under $900",
];
const TEST_REQUEST = "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";
const TEST_EXAMPLES = [
  TEST_REQUEST,
  "Laptop with 16GB RAM and 1TB SSD, refurbished is fine, 1-year warranty, under $900.",
];

const STEPS: { id: StepId; label: string; title: string }[] = [
  { id: "requirements", label: "Requirements", title: "Your requirements" },
  { id: "discovery", label: "Discovery", title: "Product discovery" },
  { id: "verification", label: "Verification", title: "PACT verification" },
  { id: "decision", label: "Decision", title: "Your decision" },
  { id: "checkout", label: "Checkout", title: "Checkout" },
  { id: "evidence", label: "Receipt", title: "Evidence receipt" },
];

type Stage = "discover" | "select" | "verify";
const STAGE_TEXT: Record<Stage, string> = {
  discover: "Searching for products…",
  select: "Your shopping agent is choosing…",
  verify: "PACT is checking the agent's pick…",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scrollToStep = (id: StepId) =>
  document
    .getElementById(`step-${id}`)
    ?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });

/** The next pipeline stage for the current requirements, or null when the check is complete. */
function nextStage(s: SessionView): Stage | null {
  const h = s.contract.hash;
  if (!s.approved) return null;
  if (s.discovery?.contractHash !== h) return "discover";
  if (s.discovery.candidates.length === 0) return null;
  if (s.agent?.contractHash !== h) return "select";
  if (s.verification?.contractHash !== h) return "verify";
  return null;
}

/** True once the check has a result for the current requirements (a verdict, or an empty search). */
function checkDone(s: SessionView | null): boolean {
  if (!s?.approved) return false;
  const h = s.contract.hash;
  return s.verification?.contractHash === h || (s.discovery?.contractHash === h && s.discovery.candidates.length === 0);
}

function deriveStatuses(session: SessionView | null, selectedId: string | null): Record<StepId, StepStatus> {
  const order = session?.order;
  const forSelected = order && session?.snapshot?.listingId === selectedId;
  const captured = forSelected && order.status === "COMPLETED";
  const captureBlocked = forSelected && order.verification && !order.verification.ok;
  const done = checkDone(session);
  const found = Boolean(session?.approved && session.discovery?.contractHash === session.contract.hash);
  return {
    requirements: !session ? "pending" : session.approved ? "completed" : "active",
    discovery: !session?.approved ? "pending" : found ? "completed" : "active",
    verification: !found ? "pending" : done ? "completed" : "active",
    decision: !done ? "pending" : selectedId ? "completed" : "active",
    checkout: !done || !selectedId ? "pending" : captured ? "completed" : captureBlocked ? "blocked" : "active",
    // The receipt records continuously; it is "done" once the payment step has an outcome.
    evidence: !session ? "pending" : order?.verification ? "completed" : "active",
  };
}

/**
 * Steps open by default when they need the user. Discovery and verification stay open
 * until the user picks a product, because that evidence is what the decision rests on.
 */
function defaultExpanded(id: StepId, status: StepStatus, picked: boolean): boolean {
  if (status === "pending") return false;
  if (id === "evidence") return status === "completed";
  if (status === "active" || status === "blocked") return true;
  if (id === "discovery" || id === "verification") return !picked;
  return id === "checkout";
}

interface UiError {
  message: string;
  code: string | null;
  /** Shown when the failed step can be retried from where it stopped. */
  retry?: () => void;
}

export function PactApp() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [mode, setMode] = useState<Mode>("live");
  const [attack, setAttack] = useState<SellerAttack | null>(null);
  const [text, setText] = useState("");
  const [session, setSessionState] = useState<SessionView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [note, setNote] = useState("");
  // User overrides are keyed by step *and* status, so a step re-opens when its status changes.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: AppConfig) => {
        setConfig(c);
        // Without Gemini and Channel3 there is no live mode; open on the clearly labelled test store instead.
        if (!c.ai || !c.catalog) setMode("test");
      })
      .catch(() => {});
  }, []);

  // The session id lives in the URL (?session=…), so a refresh or a shared link reopens the same purchase.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("session");
    if (!id) return;
    queueMicrotask(() => setRestoring(true));
    fetch(`/api/session/${encodeURIComponent(id)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as SessionView) : null))
      .catch(() => null)
      .then((s) => {
        if (s) {
          setSessionState(s);
          setText(s.requestText);
          setSelectedId(s.snapshot?.listingId ?? null);
        } else {
          window.history.replaceState(null, "", window.location.pathname);
          setError({ message: "That purchase is no longer available. Please start again.", code: null });
        }
        setRestoring(false);
      });
  }, []);

  // Screen readers hear every new evidence event (requirements confirmed, verdicts, payment…).
  const announcement = (stage && STAGE_TEXT[stage]) || (session?.events[session.events.length - 1]?.summary ?? note);

  const setSession = useCallback((s: SessionView) => {
    setSessionState(s);
    if (new URLSearchParams(window.location.search).get("session") !== s.id) {
      window.history.replaceState(null, "", `?session=${encodeURIComponent(s.id)}`);
    }
  }, []);
  const onError = useCallback((m: string) => setError({ message: m, code: null }), []);

  const statuses = useMemo(() => deriveStatuses(session, selectedId), [session, selectedId]);
  const analysis = useMemo(() => (session && checkDone(session) ? analyse(session) : null), [session]);
  const picked = Boolean(selectedId);
  const isExpanded = (id: StepId) => overrides[`${id}:${statuses[id]}`] ?? defaultExpanded(id, statuses[id], picked);
  const setExpanded = (id: StepId, value: boolean) => setOverrides((o) => ({ ...o, [`${id}:${statuses[id]}`]: value }));
  const allOpen = STEPS.every((s) => statuses[s.id] === "pending" || isExpanded(s.id));
  const toggleAll = () => {
    const next: Record<string, boolean> = { ...overrides };
    for (const s of STEPS) {
      if (statuses[s.id] === "pending") continue;
      next[`${s.id}:${statuses[s.id]}`] = allOpen ? statuses[s.id] !== "completed" || s.id === "checkout" : true;
    }
    setOverrides(next);
  };

  const summaries = useStepSummaries(session, analysis, selectedId);
  const control = (id: StepId): StepControl => ({
    id,
    n: STEPS.findIndex((s) => s.id === id) + 1,
    status: statuses[id],
    expanded: isExpanded(id),
    onToggle: () => setExpanded(id, !isExpanded(id)),
    summary: summaries[id],
  });

  const goTo = (id: StepId) => {
    setExpanded(id, true);
    setTimeout(() => scrollToStep(id), 30);
  };

  const toUiError = (e: unknown, retry?: () => void): UiError =>
    e instanceof ApiError
      ? { message: e.message, code: e.code, retry: e.status >= 500 || e.status === 429 || e.status === 0 ? retry : undefined }
      : { message: (e as Error).message, code: null };

  /** Runs an action, then moves keyboard focus to the next control so keyboard users never land back at the top. */
  const act = async (name: string, fn: () => Promise<SessionView>, focusNext?: (s: SessionView) => string) => {
    setBusy(name);
    setError(null);
    try {
      const s = await fn();
      setSession(s);
      if (focusNext) focusSoon(focusNext(s));
    } catch (e) {
      setError(toUiError(e));
    } finally {
      setBusy(null);
    }
  };

  /** search → agent picks → PACT verifies. Each stage is saved, so a failure can be retried from where it stopped. */
  const runCheck = async (start: SessionView) => {
    setBusy("check");
    setError(null);
    let s = start;
    try {
      for (let st = nextStage(s); st; st = nextStage(s)) {
        setStage(st);
        s = await sessionAction(s.id, st);
        setSession(s);
      }
      setStage(null);
      focusSoon("decision-primary");
      const target: StepId = s.discovery?.candidates.length ? "decision" : "discovery";
      setTimeout(() => scrollToStep(target), 60);
    } catch (e) {
      setError(toUiError(e, () => void runCheck(s)));
    } finally {
      setStage(null);
      setBusy(null);
    }
  };

  const reset = () => {
    window.history.replaceState(null, "", window.location.pathname);
    setSessionState(null);
    setSelectedId(null);
    setError(null);
    setOverrides({});
    setNote("Started over.");
  };

  const submitRequest = () =>
    act("start", () => post("/api/session", { text, mode, sellerAttack: attack }), () => "approve-contract");

  // Test store walkthrough: request → requirements → confirmation → the agent's pick and PACT's verdict.
  const runGuidedDemo = async () => {
    setBusy("demo");
    setError(null);
    setMode("test");
    setText(TEST_REQUEST);
    setOverrides({});
    try {
      let s = await post<SessionView>("/api/session", { text: TEST_REQUEST, mode: "test", sellerAttack: null });
      setSession(s);
      await sleep(300);
      scrollToStep("requirements");
      await sleep(1500);
      s = await sessionAction(s.id, "approve", { contractHash: s.contract.hash });
      setSession(s);
      setBusy(null);
      await runCheck(s);
    } catch (e) {
      setError(toUiError(e));
      setBusy(null);
    }
  };

  const select = (id: string) => {
    setSelectedId(id);
    setTimeout(() => scrollToStep("checkout"), 60);
    focusSoon("approve-purchase");
  };

  const changeRules = () => {
    goTo("requirements");
    focusSoon("approve-contract");
  };

  const approveAndCheck = async () => {
    if (!session) return;
    setBusy("approve");
    setError(null);
    try {
      const s = await sessionAction(session.id, "approve", { contractHash: session.contract.hash });
      setSession(s);
      setBusy(null);
      await runCheck(s);
    } catch (e) {
      setError(toUiError(e));
      setBusy(null);
    }
  };

  const liveReady = Boolean(config?.ai && config?.catalog);

  return (
    <MotionConfig reducedMotion="user">
      <a
        href="#workflow"
        className="sr-only z-50 rounded-control bg-brand px-4 py-2 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to the main content
      </a>
      <div className="min-h-screen bg-canvas">
        <header className="border-b border-line bg-canvas">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <p className="flex items-baseline gap-3">
              <span className="font-mono text-base font-medium tracking-[0.18em] text-ink">PACT</span>
              <span className="hidden text-sm text-muted sm:inline">Checks what your AI shopping agent buys</span>
            </p>
            {session && (
              <Button variant="ghost" onClick={reset}>
                <RotateCcw className="h-4 w-4" /> Start over
              </Button>
            )}
          </div>
        </header>

        {session?.isTest && <TestBanner session={session} />}
        {session && <Stepper statuses={statuses} onGo={goTo} allOpen={allOpen} onToggleAll={toggleAll} />}

        <main id="workflow" tabIndex={-1} className="mx-auto w-full max-w-6xl space-y-3 px-4 py-6 outline-none sm:px-6">
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>

          {restoring && !session && (
            <p role="status" className="py-10 text-center text-muted">
              Loading your purchase…
            </p>
          )}

          {!session && !restoring && (
            <Home
              text={text}
              setText={setText}
              mode={mode}
              setMode={setMode}
              attack={attack}
              setAttack={setAttack}
              config={config}
              liveReady={liveReady}
              onSubmit={submitRequest}
              onDemo={runGuidedDemo}
              busy={busy}
              error={error}
              clearError={() => setError(null)}
            />
          )}

          {error && session && (
            <ErrorBox
              error={error}
              onDismiss={() => setError(null)}
              onRetry={
                error.retry
                  ? () => {
                      const r = error.retry!;
                      setError(null);
                      r();
                    }
                  : undefined
              }
            />
          )}

          {session && (
            <>
              <RequestBar session={session} paid={statuses.checkout === "completed"} stopped={statuses.checkout === "blocked"} />

              <ContractCard
                key={session.contract.hash}
                control={control("requirements")}
                session={session}
                busy={busy}
                onApprove={approveAndCheck}
                onRevise={(patch: { budget?: { max: number; currency: string } | null; constraints?: Constraint[] }) => {
                  setSelectedId(null);
                  act("revise", () => sessionAction(session.id, "revise", { patch }), () => "approve-contract");
                }}
              />

              {busy === "check" && stage && <Progress stage={stage} />}

              {analysis ? (
                <DiscoveryStep control={control("discovery")} session={session} analysis={analysis} />
              ) : (
                <PendingStep id="discovery" hint="PACT searches after you confirm your requirements." control={control("discovery")} />
              )}

              {analysis ? (
                <VerificationStep control={control("verification")} session={session} analysis={analysis} />
              ) : (
                <PendingStep
                  id="verification"
                  hint="PACT checks the agent's pick right after it chooses."
                  control={control("verification")}
                />
              )}

              {analysis ? (
                <DecisionStep
                  control={control("decision")}
                  session={session}
                  analysis={analysis}
                  selectedId={selectedId}
                  onSelect={select}
                  onChangeRules={changeRules}
                />
              ) : (
                <PendingStep id="decision" hint="You'll see Match, Check first or Blocked, and why." control={control("decision")} />
              )}

              {analysis && selectedId && config && findVerified(session, selectedId) ? (
                <Checkout
                  key={selectedId}
                  control={control("checkout")}
                  session={session}
                  selectedId={selectedId}
                  config={config}
                  setSession={setSession}
                  onError={onError}
                />
              ) : (
                <PendingStep
                  id="checkout"
                  hint="After you choose a product, you approve the item price, then pay with PayPal Sandbox."
                  control={control("checkout")}
                />
              )}

              <Evidence control={control("evidence")} session={session} />
            </>
          )}

          <footer className="pb-8 pt-4 text-center text-xs text-faint">
            Payments use PayPal Sandbox test money. No real money moves.
            {config && (
              <span className="mt-1 block">
                PayPal {config.paypal === "sandbox" ? "Sandbox" : "simulator"} · AI {config.ai ? config.aiModel : "not configured"}{" "}
                · catalog {config.catalog ? "Channel3" : "not configured"} · storage {config.storage}
              </span>
            )}
          </footer>
        </main>
      </div>
    </MotionConfig>
  );
}

function PendingStep({ id, hint, control }: { id: StepId; hint: string; control: StepControl }) {
  const step = STEPS.find((s) => s.id === id)!;
  return <Step control={{ ...control, summary: hint }} title={step.title} />;
}

function Progress({ stage }: { stage: Stage }) {
  const order: Stage[] = ["discover", "select", "verify"];
  const at = order.indexOf(stage);
  return (
    <div role="status" className="rounded-card border border-line bg-surface px-5 py-4">
      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {order.map((st, i) => (
          <li key={st} className={cn("flex items-center gap-2", i < at ? "text-pass" : i === at ? "text-ink" : "text-faint")}>
            {i < at ? (
              <Check className="h-4 w-4" />
            ) : i === at ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <span className="h-4 w-4" />
            )}
            {STAGE_TEXT[st].replace("…", "")}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ErrorBox({ error, onDismiss, onRetry }: { error: UiError; onDismiss: () => void; onRetry?: () => void }) {
  const title =
    error.code === "AI_UNAVAILABLE"
      ? "AI unavailable"
      : error.code === "CATALOG_UNAVAILABLE"
        ? "Product catalog unavailable"
        : error.code === "RATE_LIMITED"
          ? "Slow down"
          : "Something went wrong";
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-card border border-block-line border-l-4 border-l-block bg-block-soft px-4 py-3 text-sm text-ink"
    >
      <div>
        <p>
          <span className="font-semibold text-block">{title}: </span>
          {error.message}
        </p>
        {error.code === "AI_UNAVAILABLE" && (
          <p className="mt-1 text-ink-2">PACT won&apos;t guess or check a product without AI. Nothing was bought or charged.</p>
        )}
        {onRetry && (
          <Button variant="secondary" className="mt-2" onClick={onRetry}>
            <RotateCcw className="h-4 w-4" /> Try again from here
          </Button>
        )}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss error" className="rounded p-1 text-block hover:bg-block-line">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function TestBanner({ session }: { session: SessionView }) {
  return (
    <div className="border-b border-flag-line bg-flag-soft">
      <p className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 text-sm font-medium text-flag sm:px-6">
        <FlaskConical className="h-4 w-4 shrink-0" />
        TEST ·{" "}
        {session.sellerAttack
          ? `Seller Mode: ${ATTACK_INFO[session.sellerAttack].title}. A product is deliberately altered to test PACT.`
          : "Test store: fictional laptops and a simple test agent, no AI."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Homepage: one question, one button                                  */
/* ------------------------------------------------------------------ */

const AFTER_CLICK = [
  { title: "Your requirements", text: "PACT turns your words into requirements and a budget. You confirm them." },
  { title: "Product discovery", text: "PACT searches real products and an AI shopping agent picks one." },
  { title: "PACT verification", text: "The pick is compared with your requirements, the seller's listing and the price." },
  { title: "Your decision", text: "You see Match, Check first or Blocked, and exactly why." },
  { title: "Checkout and receipt", text: "Only if you approve, you pay with PayPal Sandbox. PACT re-checks the amount first." },
];

const MODES = [
  { m: "live", title: "Real products", text: "Gemini reads your request, Channel3 finds real products." },
  { m: "test", title: "Test store", text: "Fictional laptops with planted traps. No AI, labelled TEST." },
] as const;

function Home({
  text,
  setText,
  mode,
  setMode,
  attack,
  setAttack,
  config,
  liveReady,
  onSubmit,
  onDemo,
  busy,
  error,
  clearError,
}: {
  text: string;
  setText: (t: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  attack: SellerAttack | null;
  setAttack: (a: SellerAttack | null) => void;
  config: AppConfig | null;
  liveReady: boolean;
  onSubmit: () => void;
  onDemo: () => void;
  busy: string | null;
  error: UiError | null;
  clearError: () => void;
}) {
  const examples = mode === "live" ? LIVE_EXAMPLES : TEST_EXAMPLES;
  const liveBlocked = mode === "live" && config !== null && !liveReady;
  const missing = [!config?.ai && "AI (Gemini)", !config?.catalog && "the product catalog (Channel3)"].filter(Boolean);
  return (
    <div className="mx-auto max-w-3xl pb-8 pt-4 sm:pt-10">
      <section aria-labelledby="home-title">
        <h1 id="home-title" className="text-[1.875rem] font-semibold leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]">
          Tell PACT what you want. AI finds it, PACT checks it, you approve the payment.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
          PACT checks the product an AI shopping agent picks against your own words and the seller&apos;s listing, before
          any PayPal payment goes through.
        </p>
      </section>

      <form
        className="mt-8 border-t border-ink pt-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !liveBlocked) onSubmit();
        }}
      >
        <fieldset className="mb-5">
          <legend className="eyebrow text-muted">Where to shop</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {MODES.map((o) => (
              <label
                key={o.m}
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5 text-sm",
                  mode === o.m ? "border-ink bg-surface" : "border-line-strong hover:border-ink",
                )}
              >
                <input
                  type="radio"
                  name="mode"
                  className="mt-1"
                  checked={mode === o.m}
                  onChange={() => {
                    setMode(o.m);
                    clearError();
                  }}
                />
                <span>
                  <span className="font-medium text-ink">{o.title}</span>
                  <span className="block text-muted">{o.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {liveBlocked && (
          <p role="status" className="mb-4 border-l-2 border-flag-icon bg-flag-soft px-3 py-2 text-sm text-ink">
            <AlertTriangle className="mr-1 inline h-4 w-4 text-flag" />
            Real products are unavailable: {missing.join(" and ")} isn&apos;t configured on this server. PACT won&apos;t
            guess without them. Use the test store instead.
          </p>
        )}

        <label htmlFor="request-text" className="block text-xl font-semibold tracking-[-0.01em] text-ink">
          What do you want to buy?
        </label>
        <p id="request-hint" className="mt-1 text-sm text-muted">
          Say it in your own words: what it is, what matters to you and the most you want to pay.
          {mode === "test" && " The test store only sells laptops."}
        </p>
        <textarea
          id="request-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) clearError();
          }}
          aria-describedby="request-hint privacy-note"
          rows={3}
          maxLength={600}
          placeholder={mode === "live" ? "e.g. A dark chocolate bar with at least 70% cocoa, under $10" : TEST_REQUEST}
          className="input mt-3 min-h-[96px] resize-none text-base leading-relaxed"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Example requests">
          <span className="eyebrow text-faint">Try</span>
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              aria-pressed={text === ex}
              onClick={() => setText(ex)}
              className={cn(
                "min-h-8 rounded-control border px-3 py-1 text-left text-sm transition-colors",
                text === ex ? "border-ink bg-ink text-white" : "border-line-strong bg-surface text-ink-2 hover:border-ink",
              )}
            >
              {ex}
            </button>
          ))}
        </div>

        <Details summary="Seller Mode: security test for judges" className="mt-5">
          <fieldset className="border-l-2 border-flag-line pl-3">
            <legend className="sr-only">Seller Mode attack</legend>
            <p className="text-sm text-muted">
              Seller Mode alters a copy of the agent&apos;s pick to act like a dishonest seller, so you can watch PACT catch
              it. The altered product is synthetic and every receipt is marked TEST.
            </p>
            <div className="mt-2 space-y-1.5">
              {[null, ...SELLER_ATTACKS].map((a) => (
                <label key={a ?? "off"} className="flex min-h-7 cursor-pointer items-start gap-2 text-sm">
                  <input type="radio" name="attack" className="mt-1" checked={attack === a} onChange={() => setAttack(a)} />
                  <span>
                    <span className="font-medium text-ink">{a ? ATTACK_INFO[a].title : "Off"}</span>
                    {a && <span className="block text-muted">{ATTACK_INFO[a].what}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </Details>

        {error && (
          <p role="alert" className="mt-4 border-l-2 border-block bg-block-soft px-3 py-2 text-sm text-ink">
            <span className="font-semibold text-block">
              {error.code === "AI_UNAVAILABLE"
                ? "AI unavailable: "
                : error.code === "NOT_SHOPPING" || error.code === "NOT_UNDERSTOOD"
                  ? "PACT couldn't use that: "
                  : "Something went wrong: "}
            </span>
            {error.message}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button
            type="submit"
            className="min-h-12 px-6 text-base"
            loading={busy === "start"}
            disabled={busy === "demo" || text.trim().length < 5 || liveBlocked}
          >
            Check my purchase
          </Button>
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Lock className="h-3.5 w-3.5" /> This only runs a check. Nothing is bought or charged.
          </p>
        </div>
        <p id="privacy-note" className="mt-4 text-xs leading-relaxed text-muted">
          {mode === "live"
            ? "Don't include personal details (name, address, card numbers). Your request is sent to Google Gemini on the free tier, where Google may use prompts to improve its products. Product data comes from Channel3; PACT shows the merchant's domain only, with no affiliate links. Requests are kept for 7 days."
            : "Test store mode sends nothing to an AI service. Products are fictional."}
        </p>
      </form>

      <section aria-labelledby="after-title" className="mt-12 border-t border-line pt-6">
        <h2 id="after-title" className="text-lg font-semibold tracking-[-0.01em] text-ink">
          What happens after you click
        </h2>
        <ol className="mt-4 border-t border-line">
          {AFTER_CLICK.map((s, i) => (
            <li
              key={s.title}
              className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 border-b border-line py-3 sm:grid-cols-[2.25rem_11rem_minmax(0,1fr)]"
            >
              <span className="num font-mono text-sm text-faint">{stepNumber(i + 1)}</span>
              <span className="font-medium text-ink">{s.title}</span>
              <span className="col-start-2 text-sm text-muted sm:col-start-3">{s.text}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-ink-2">
          PACT checks the item price against your budget. Shipping, tax and the merchant&apos;s own checkout total are not
          verified.
        </p>
      </section>

      <div className="mt-10 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDemo} loading={busy === "demo"} disabled={busy === "start"}>
          <PlayCircle className="h-4 w-4" /> Watch a quick demo
        </Button>
        <span className="ml-3 text-sm text-muted">Runs a laptop request in the test store.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* After submitting: request summary, services and payment status      */
/* ------------------------------------------------------------------ */

const SERVICE_NAME = { ai: "AI", catalog: "Catalog", payments: "Payments" } as const;

function RequestBar({ session, paid, stopped }: { session: SessionView; paid: boolean; stopped: boolean }) {
  const status = paid
    ? { icon: Check, text: "Paid with PayPal Sandbox", tone: "text-pass" }
    : stopped
      ? { icon: ShieldX, text: "Payment stopped. Nothing was charged", tone: "text-block" }
      : { icon: Lock, text: "Nothing charged yet. You pay in step 5, after you approve", tone: "text-ink-2" };
  const Icon = status.icon;
  const services = (Object.keys(SERVICE_NAME) as (keyof typeof SERVICE_NAME)[]).filter((k) => session.services[k]);
  return (
    <div className="border-b border-line pb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-2">
        <div className="min-w-0 max-w-2xl">
          <p className="eyebrow text-faint">Your request</p>
          <p className="mt-0.5 text-[15px] text-ink">“{session.requestText}”</p>
        </div>
        <p className={cn("flex items-center gap-1.5 pt-4 text-sm font-medium", status.tone)}>
          <Icon className="h-4 w-4 shrink-0" />
          {status.text}
        </p>
      </div>
      {services.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span className="eyebrow text-faint">How this ran</span>
          {services.map((k) => {
            const sv = session.services[k]!;
            const tone =
              sv.state === "error" || sv.state === "unavailable" ? "text-block" : sv.state === "live" ? "text-ink-2" : "text-flag";
            return (
              <span key={k}>
                {SERVICE_NAME[k]}: <span className={tone}>{sv.detail}</span>
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}

function Stepper({
  statuses,
  onGo,
  allOpen,
  onToggleAll,
}: {
  statuses: Record<StepId, StepStatus>;
  onGo: (id: StepId) => void;
  allOpen: boolean;
  onToggleAll: () => void;
}) {
  const current =
    STEPS.find((s) => s.id !== "evidence" && (statuses[s.id] === "active" || statuses[s.id] === "blocked"))?.id ??
    (statuses.evidence === "completed" ? "evidence" : undefined);
  const currentStep = STEPS.find((s) => s.id === current);
  return (
    <nav aria-label="Where you are in the check" className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-stretch gap-3 px-4 sm:px-6">
        <ol className="grid flex-1 grid-cols-6">
          {STEPS.map((s, i) => {
            const st = statuses[s.id];
            const isCurrent = s.id === current;
            return (
              <li key={s.id} className="flex min-w-0">
                <button
                  type="button"
                  disabled={st === "pending"}
                  onClick={() => onGo(s.id)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 border-b-2 py-3 pr-2 text-left text-sm transition-colors",
                    isCurrent ? "border-ink" : "border-transparent",
                    st !== "pending" && !isCurrent && "hover:border-line-strong",
                  )}
                >
                  <StepMarker n={i + 1} status={st === "active" && !isCurrent ? "pending" : st} small />
                  <span
                    className={cn(
                      "hidden truncate lg:block",
                      isCurrent ? "font-semibold text-ink" : st === "pending" ? "text-faint" : "text-ink-2",
                    )}
                  >
                    {s.label}
                  </span>
                  <span className="sr-only">
                    {" "}
                    {s.label}: {STATUS_TEXT[st]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <Button variant="ghost" className="my-1.5 shrink-0 px-2.5 text-xs" onClick={onToggleAll}>
          {allOpen ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
          <span className="hidden sm:inline">{allOpen ? "Show less" : "Show all"}</span>
          <span className="sr-only sm:hidden">{allOpen ? "Show less" : "Show all steps"}</span>
        </Button>
      </div>
      {currentStep && (
        <p className="mx-auto max-w-6xl px-4 pb-2 text-xs text-muted sm:px-6 lg:hidden" aria-hidden="true">
          Step {STEPS.indexOf(currentStep) + 1} of 6 · <span className="font-medium text-ink">{currentStep.label}</span>
        </p>
      )}
    </nav>
  );
}

function useStepSummaries(session: SessionView | null, analysis: Analysis | null, selectedId: string | null) {
  return useMemo(() => {
    const out: Partial<Record<StepId, React.ReactNode>> = {};
    if (!session) return out;

    const r = session.contract.requirements;
    out.requirements = `${requirementTerms(r).join(" · ")}${session.approved ? "" : " · not confirmed yet"}`;

    if (analysis) {
      const { agent, subject } = analysis;
      out.discovery = agent
        ? `Agent picked ${agent.record.title} at ${money(agent.record.offer.price, agent.record.offer.currency)}`
        : "No products found";
      out.verification = subject
        ? `${subject.record.title}: ${VERDICT_LABEL[subject.evaluation.verdict]}, ${
            subject.evaluation.checks.filter((c) => c.status !== "pass").length
          } of ${subject.evaluation.checks.length} checks need attention`
        : "Nothing to verify";
      const chosen = selectedId ? findVerified(session, selectedId) : null;
      out.decision = chosen ? `You chose ${chosen.record.title}` : undefined;
    }
    const o = session.order;
    if (o?.status === "COMPLETED") out.checkout = "Paid with PayPal Sandbox";
    out.evidence = `${session.events.length} steps recorded${session.chain.valid ? "" : " · edited, can't be trusted"}`;
    return out;
  }, [session, analysis, selectedId]);
}
