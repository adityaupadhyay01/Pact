"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { Check, ChevronsDownUp, ChevronsUpDown, Lock, PlayCircle, RotateCcw, ShieldX, X } from "lucide-react";
import type { Requirements } from "@/lib/contract";
import { extractFactsHeuristic, parseRequestHeuristic } from "@/lib/heuristics";
import { groundFacts } from "@/lib/facts";
import { detectInjection, visibleText } from "@/lib/injection";
import { getListing } from "@/lib/marketplace";
import { evaluate } from "@/lib/rules";
import { Checkout, type AppConfig } from "./Checkout";
import { ChecksList } from "./Checks";
import { ContractCard } from "./ContractCard";
import { Evidence } from "./Evidence";
import { DecisionStep, DiscoveryStep, VerificationStep } from "./FlowSteps";
import { analyse, joinLabels, requirementTerms, type Analysis } from "./flow";
import {
  Button,
  STATUS_TEXT,
  Step,
  StepMarker,
  VERDICT_LABEL,
  VerdictBadge,
  cn,
  focusSoon,
  money,
  stepNumber,
  type StepControl,
  type StepId,
  type StepStatus,
} from "./ui";
import { post, sessionAction, type SessionView } from "./api";

const DEMO_REQUEST =
  "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";

const EXAMPLES = [
  { label: "New laptop, 2-year warranty", text: DEMO_REQUEST },
  {
    label: "Refurbished is fine",
    text: "Laptop with 16GB RAM and 1TB SSD, refurbished or used is fine, 1-year warranty, under $900.",
  },
  { label: "Smaller budget", text: "A new laptop with 16GB RAM and at least 512GB SSD. Budget of $750." },
];

const STEPS: { id: StepId; label: string; title: string }[] = [
  { id: "requirements", label: "Requirements", title: "Your requirements" },
  { id: "discovery", label: "Discovery", title: "Product discovery" },
  { id: "verification", label: "Verification", title: "PACT verification" },
  { id: "decision", label: "Decision", title: "Your decision" },
  { id: "checkout", label: "Checkout", title: "Checkout" },
  { id: "evidence", label: "Receipt", title: "Evidence receipt" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scrollToStep = (id: StepId) =>
  document
    .getElementById(`step-${id}`)
    ?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });

function deriveStatuses(session: SessionView | null, selectedId: string | null): Record<StepId, StepStatus> {
  const order = session?.order;
  const forSelected = order && session?.snapshot?.listingId === selectedId;
  const captured = forSelected && order.status === "COMPLETED";
  const captureBlocked = forSelected && order.verification && !order.verification.ok;
  const searched = Boolean(session?.search);
  return {
    requirements: !session ? "pending" : session.approved ? "completed" : "active",
    discovery: !session?.approved ? "pending" : searched ? "completed" : "active",
    verification: !searched ? "pending" : "completed",
    decision: !searched ? "pending" : selectedId ? "completed" : "active",
    checkout: !searched || !selectedId ? "pending" : captured ? "completed" : captureBlocked ? "blocked" : "active",
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

export function PactApp() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [text, setText] = useState(DEMO_REQUEST);
  const [session, setSessionState] = useState<SessionView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // User overrides are keyed by step *and* status, so a step re-opens when its status changes.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => {});
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
          setError("That purchase is no longer available (the demo server may have restarted). Please start again.");
        }
        setRestoring(false);
      });
  }, []);

  // Screen readers hear every new evidence event (requirements confirmed, verdicts, payment…).
  const announcement = session?.events[session.events.length - 1]?.summary ?? note;

  const setSession = useCallback((s: SessionView) => {
    setSessionState(s);
    if (new URLSearchParams(window.location.search).get("session") !== s.id) {
      window.history.replaceState(null, "", `?session=${encodeURIComponent(s.id)}`);
    }
  }, []);
  const onError = useCallback((m: string) => setError(m), []);

  const statuses = useMemo(() => deriveStatuses(session, selectedId), [session, selectedId]);
  const analysis = useMemo(() => (session ? analyse(session) : null), [session]);
  const picked = Boolean(selectedId);
  const isExpanded = (id: StepId) =>
    overrides[`${id}:${statuses[id]}`] ?? defaultExpanded(id, statuses[id], picked);
  const setExpanded = (id: StepId, value: boolean) =>
    setOverrides((o) => ({ ...o, [`${id}:${statuses[id]}`]: value }));
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

  /** Runs an action, then moves keyboard focus to the next control so keyboard users never land back at the top. */
  const act = async (name: string, fn: () => Promise<SessionView>, focusNext?: (s: SessionView) => string) => {
    setBusy(name);
    setError(null);
    try {
      const s = await fn();
      setSession(s);
      if (focusNext) focusSoon(focusNext(s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
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

  const submitRequest = () => act("start", () => post("/api/session", { text }), () => "approve-contract");

  // Walks through request → requirements → confirmation → the agent's pick and PACT's verdict.
  const runGuidedDemo = async () => {
    setBusy("demo");
    setError(null);
    setText(DEMO_REQUEST);
    setOverrides({});
    try {
      let s = await post<SessionView>("/api/session", { text: DEMO_REQUEST });
      setSession(s);
      await sleep(300);
      scrollToStep("requirements");
      await sleep(1800);
      await sessionAction(s.id, "approve", { contractHash: s.contract.hash });
      s = await sessionAction(s.id, "search");
      setSession(s);
      await sleep(100);
      scrollToStep("discovery");
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
              onSubmit={submitRequest}
              onDemo={runGuidedDemo}
              busy={busy}
            />
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 rounded-card border border-block-line border-l-4 border-l-block bg-block-soft px-4 py-3 text-sm text-ink"
            >
              <span>
                <span className="font-semibold text-block">Something went wrong: </span>
                {error}
              </span>
              <button onClick={() => setError(null)} aria-label="Dismiss error" className="rounded p-1 text-block hover:bg-block-line">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {session && (
            <>
              <RequestBar session={session} paid={statuses.checkout === "completed"} stopped={statuses.checkout === "blocked"} />

              <ContractCard
                key={session.contract.hash}
                control={control("requirements")}
                session={session}
                busy={busy}
                onApprove={() =>
                  act(
                    "approve",
                    async () => {
                      // Confirming the requirements runs the whole check in one click.
                      await sessionAction(session.id, "approve", { contractHash: session.contract.hash });
                      return sessionAction(session.id, "search");
                    },
                    () => "decision-primary",
                  )
                }
                onRevise={(patch: Partial<Requirements>) => {
                  setSelectedId(null);
                  act("revise", () => sessionAction(session.id, "revise", { patch }), () => "approve-contract");
                }}
              />

              {analysis ? (
                <DiscoveryStep control={control("discovery")} session={session} analysis={analysis} />
              ) : (
                <PendingStep id="discovery" hint="Your agent shops after you confirm your requirements." control={control("discovery")} />
              )}

              {analysis ? (
                <VerificationStep control={control("verification")} session={session} analysis={analysis} />
              ) : (
                <PendingStep id="verification" hint="PACT checks the agent's pick right after it chooses." control={control("verification")} />
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

              {session.search && selectedId && config ? (
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
                <PendingStep id="checkout" hint="After you choose a product, you approve the exact price, then pay with PayPal." control={control("checkout")} />
              )}

              <Evidence control={control("evidence")} session={session} />
            </>
          )}

          <footer className="pb-8 pt-4 text-center text-xs text-faint">
            Demo store with made-up laptops. No real money moves.
            {config && (
              <span className="mt-1 block">
                PayPal {config.paypal} · AI {config.ai ? "Gemini" : "rule-based"} · storage {config.storage}
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

/* ------------------------------------------------------------------ */
/* Homepage: one question, one button                                  */
/* ------------------------------------------------------------------ */

const AFTER_CLICK = [
  {
    title: "Your requirements",
    text: "PACT turns your request into rules: what's required and your budget. You confirm them.",
  },
  {
    title: "Product discovery",
    text: "An AI shopping agent searches a demo store and picks a product.",
  },
  {
    title: "PACT verification",
    text: "The pick is compared with your rules, the seller's listing and the final price.",
  },
  {
    title: "Your decision",
    text: "You see Match, Check first or Blocked, and exactly why.",
  },
  {
    title: "Checkout and receipt",
    text: "Only if you approve, you pay with PayPal. PACT re-checks the amount first, then saves a receipt.",
  },
];

function Home({
  text,
  setText,
  onSubmit,
  onDemo,
  busy,
}: {
  text: string;
  setText: (t: string) => void;
  onSubmit: () => void;
  onDemo: () => void;
  busy: string | null;
}) {
  return (
    <div className="mx-auto max-w-3xl pb-8 pt-4 sm:pt-10">
      <section aria-labelledby="home-title">
        <h1
          id="home-title"
          className="text-[1.875rem] font-semibold leading-[1.12] tracking-[-0.02em] text-ink sm:text-[2.5rem]"
        >
          Make sure your AI shopping agent buys exactly what you asked for.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
          PACT checks the product, the seller&apos;s listing and the final price against your request, before your
          PayPal payment goes through.
        </p>
      </section>

      <form
        className="mt-8 border-t border-ink pt-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        <label htmlFor="request-text" className="block text-xl font-semibold tracking-[-0.01em] text-ink">
          What do you want your AI shopping agent to buy?
        </label>
        <p id="request-hint" className="mt-1 text-sm text-muted">
          Write it in your own words: what it is, what matters, and your maximum budget. An example is filled in. Edit
          it, or pick another below.
        </p>
        <textarea
          id="request-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="request-hint"
          rows={3}
          className="input mt-3 min-h-[96px] resize-none text-base leading-relaxed"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Example requests">
          <span className="eyebrow text-faint">Examples</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              aria-pressed={text === ex.text}
              onClick={() => setText(ex.text)}
              className={cn(
                "min-h-8 rounded-control border px-3 py-1 text-sm transition-colors",
                text === ex.text ? "border-ink bg-ink text-white" : "border-line-strong bg-surface text-ink-2 hover:border-ink",
              )}
            >
              {ex.label}
            </button>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button type="submit" className="min-h-12 px-6 text-base" loading={busy === "start"} disabled={busy === "demo" || text.trim().length < 5}>
            Check my purchase
          </Button>
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Lock className="h-3.5 w-3.5" /> This only runs a check. Nothing is bought or charged.
          </p>
        </div>
      </form>

      <section aria-labelledby="after-title" className="mt-12 border-t border-line pt-6">
        <h2 id="after-title" className="text-lg font-semibold tracking-[-0.01em] text-ink">
          What happens after you click
        </h2>
        <ol className="mt-4 border-t border-line">
          {AFTER_CLICK.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 border-b border-line py-3 sm:grid-cols-[2.25rem_11rem_minmax(0,1fr)]">
              <span className="num font-mono text-sm text-faint">{stepNumber(i + 1)}</span>
              <span className="font-medium text-ink">{s.title}</span>
              <span className="col-start-2 text-sm text-muted sm:col-start-3">{s.text}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-ink-2">
          You pay in step 5 at the earliest, and only after you approve the verified purchase.
        </p>
      </section>

      <ExampleCatch />

      <div className="mt-10 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDemo} loading={busy === "demo"} disabled={busy === "start"}>
          <PlayCircle className="h-4 w-4" /> Watch a 10-second demo
        </Button>
        <span className="ml-3 text-sm text-muted">Runs the example above automatically.</span>
      </div>
    </div>
  );
}

/** A real run of PACT's rule engine on one trap listing, so the value is shown, not described. */
function ExampleCatch() {
  const example = useMemo(() => {
    const listing = getListing("L-102")!;
    const requirements = parseRequestHeuristic(DEMO_REQUEST);
    const visible = visibleText(listing.html);
    const { facts } = groundFacts(extractFactsHeuristic(visible), visible);
    const evaluation = evaluate({
      requirements,
      facts,
      listedPrice: listing.listedPrice,
      quote: listing.checkout,
      injection: detectInjection(listing.html),
    });
    return { listing, requirements, evaluation };
  }, []);
  const { listing, requirements, evaluation } = example;
  const problems = evaluation.checks.filter((c) => c.status !== "pass");

  return (
    <section aria-labelledby="example-title" className="mt-12 border-t border-line pt-6">
      <h2 id="example-title" className="text-lg font-semibold tracking-[-0.01em] text-ink">
        Why it matters: a real example
      </h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-2">
        You ask for <span className="font-medium">{requirementTerms(requirements).join(", ")}</span>. An agent picks{" "}
        <span className="font-medium">{listing.title.split(" — ")[0]}</span> at{" "}
        <span className="num font-medium">{money(evaluation.totalCents / 100)}</span>: the headline says 16GB and 1TB,
        so it looks perfect. PACT reads the fine print:
      </p>
      <div className="mt-4 border-t border-ink pt-2">
        <div className="mb-1 flex items-center gap-3">
          <VerdictBadge verdict={evaluation.verdict} large />
          <span className="text-sm text-muted">
            {problems.length} of {evaluation.checks.length} rules broken: {joinLabels(problems.map((c) => c.label))}
          </span>
        </div>
        <ChecksList checks={evaluation.checks} onlyIssues />
      </div>
      <p className="mt-3 text-sm text-ink-2">
        A normal checkout would have charged you the {money(evaluation.totalCents / 100)} without a second look.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* After submitting: request summary and payment status                */
/* ------------------------------------------------------------------ */

function RequestBar({ session, paid, stopped }: { session: SessionView; paid: boolean; stopped: boolean }) {
  const status = paid
    ? { icon: Check, text: "Paid with PayPal", tone: "text-pass" }
    : stopped
      ? { icon: ShieldX, text: "Payment stopped. Nothing was charged", tone: "text-block" }
      : { icon: Lock, text: "Nothing charged yet. You pay in step 5, after you approve", tone: "text-ink-2" };
  const Icon = status.icon;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-2 border-b border-line pb-4">
      <div className="min-w-0 max-w-2xl">
        <p className="eyebrow text-faint">Your request</p>
        <p className="mt-0.5 text-[15px] text-ink">“{session.requestText}”</p>
      </div>
      <p className={cn("flex items-center gap-1.5 pt-4 text-sm font-medium", status.tone)}>
        <Icon className="h-4 w-4 shrink-0" />
        {status.text}
      </p>
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
        ? `Agent picked ${agent.listing.title} at ${money(agent.listing.listedPrice, agent.listing.currency)}`
        : "Agent found nothing that fits";
      out.verification = subject
        ? `${subject.listing.title}: ${VERDICT_LABEL[subject.evaluation.verdict]}, ${
            subject.evaluation.checks.filter((c) => c.status !== "pass").length
          } of ${subject.evaluation.checks.length} rules need attention`
        : "Nothing to verify";
      const chosen = selectedId ? getListing(selectedId) : null;
      out.decision = chosen ? `You chose ${chosen.title}` : undefined;
    }
    const o = session.order;
    if (o?.status === "COMPLETED") out.checkout = "Paid with PayPal";
    out.evidence = `${session.events.length} steps recorded${session.chain.valid ? "" : " · edited, can't be trusted"}`;
    return out;
  }, [session, analysis, selectedId]);
}
