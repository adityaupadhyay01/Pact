"use client";

import { AlertTriangle, CheckCircle2, EyeOff, ShieldX } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { hiddenSegments } from "@/lib/injection";
import { ChecksList } from "./Checks";
import { ListingsBody } from "./ListingsPanel";
import { joinLabels, requirementTerms, type Analysis } from "./flow";
import { Button, Details, Step, type StepControl, cn, money } from "./ui";
import type { SessionView } from "./api";

/* ------------------------------------------------------------------ */
/* Step 2: Product discovery                                          */
/* ------------------------------------------------------------------ */

export function DiscoveryStep({
  control,
  session,
  analysis,
}: {
  control: StepControl;
  session: SessionView;
  analysis: Analysis;
}) {
  const { agent, listingCount } = analysis;
  return (
    <Step
      control={control}
      title="Product discovery"
      subtitle={
        agent
          ? `Your shopping agent searched ${listingCount} listings and picked one. It hasn't bought anything yet.`
          : `Your shopping agent searched ${listingCount} listings and found nothing that fits.`
      }
    >
      <div className="p-5 sm:p-6">
        {agent ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-labelledby="picked-title">
              <h3 id="picked-title" className="eyebrow text-muted">
                The agent picked
              </h3>
              <p className="mt-2 text-xl font-semibold tracking-[-0.01em] text-ink">{agent.listing.title}</p>
              <p className="text-sm text-muted">Sold by {agent.listing.seller}</p>
              <p className="num mt-3 font-mono text-2xl font-medium text-ink">
                {money(agent.listing.listedPrice, agent.listing.currency)}
                <span className="ml-2 font-sans text-sm font-normal text-muted">price on the listing</span>
              </p>
              <figure className="mt-5 border-l-2 border-line-strong pl-3">
                <figcaption className="eyebrow text-faint">What the agent told you</figcaption>
                <blockquote className="mt-1 text-[15px] italic text-ink-2">“{agent.claim}”</blockquote>
              </figure>
            </section>
            <section aria-labelledby="why-title">
              <h3 id="why-title" className="eyebrow text-muted">
                How it chose
              </h3>
              <ol className="mt-2 border-t border-line">
                {agent.reasoning.map((r, i) => (
                  <li key={i} className="flex gap-3 border-b border-line py-2.5 text-sm text-ink-2">
                    <span className="num font-mono text-faint">{String(i + 1).padStart(2, "0")}</span>
                    {r}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-sm text-muted">
                This agent works on its own: it doesn&apos;t check the fine print or the final price. That&apos;s what
                PACT does next.
              </p>
            </section>
          </div>
        ) : (
          <p className="max-w-xl text-sm text-ink-2">
            Nothing under {formatMoney(session.contract.requirements.maxTotal, session.contract.requirements.currency)}{" "}
            matched your specs. PACT still checked every listing in the next step.
          </p>
        )}
      </div>
    </Step>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: PACT verification                                          */
/* ------------------------------------------------------------------ */

export function VerificationStep({
  control,
  session,
  analysis,
}: {
  control: StepControl;
  session: SessionView;
  analysis: Analysis;
}) {
  const { subject, agent } = analysis;
  const r = session.contract.requirements;
  if (!subject) {
    return (
      <Step control={control} title="PACT verification" subtitle="There was no product to verify.">
        <p className="p-5 text-sm text-ink-2 sm:p-6">No listing matched, so there is nothing to compare.</p>
      </Step>
    );
  }
  const { listing, evaluation, total } = subject;
  const hidden = hiddenSegments(listing.html);
  const q = listing.checkout;
  const claim = agent?.listing.id === listing.id ? agent.claim : null;
  const broken = evaluation.checks.filter((c) => c.status !== "pass").length;

  const sources: { n: string; title: string; body: React.ReactNode }[] = [
    {
      n: "1",
      title: "Your request",
      body: (
        <ul className="space-y-0.5">
          {requirementTerms(r).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ),
    },
    {
      n: "2",
      title: "The seller's listing",
      body: (
        <>
          <p className="font-medium text-ink">{listing.title}</p>
          <p className="text-muted">{listing.seller}</p>
          {hidden.length > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-block">
              <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Contains hidden text aimed at AI agents
            </p>
          )}
        </>
      ),
    },
    {
      n: "3",
      title: "What the agent told you",
      body: claim ? <p className="italic">“{claim}”</p> : <p className="text-muted">No claim to compare.</p>,
    },
    {
      n: "4",
      title: "What you'd pay",
      body: (
        <>
          <p className="num font-mono text-lg font-medium text-ink">{money(total, q.currency)}</p>
          <p className="num text-muted">
            {money(q.itemPrice, q.currency)} item
            {q.tax ? ` + ${money(q.tax, q.currency)} tax` : ""}
            {q.shipping ? ` + ${money(q.shipping, q.currency)} shipping` : ""}
            {q.fees.length ? ` + ${money(q.fees.reduce((s, f) => s + f.amount, 0), q.currency)} fees` : ""}
          </p>
        </>
      ),
    },
  ];

  return (
    <Step
      control={control}
      title="PACT verification"
      subtitle={`PACT lines up four things for ${listing.title}: your request, the seller's listing, what the agent told you and what you'd pay.`}
    >
      <div className="p-5 sm:p-6">
        <dl className="grid border-y border-ink sm:grid-cols-2 lg:grid-cols-4 [&>div]:border-b [&>div]:border-line [&>div:last-child]:border-b-0 sm:[&>div]:border-b-0 sm:[&>div]:pr-4 lg:[&>div+div]:border-l lg:[&>div+div]:pl-4">
          {sources.map((s) => (
            <div key={s.n} className="py-3 text-sm">
              <dt className="eyebrow flex items-center gap-1.5 text-faint">
                <span className="num">{s.n}</span> {s.title}
              </dt>
              <dd className="mt-1.5 text-ink-2">{s.body}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mt-6 flex flex-wrap items-baseline gap-x-3 text-sm font-semibold text-ink">
          Rule by rule
          <span className="text-sm font-normal text-muted">
            {broken === 0 ? `All ${evaluation.checks.length} rules met.` : `${broken} of ${evaluation.checks.length} rules need attention.`}
          </span>
        </h3>
        <div className="mt-2">
          <ChecksList checks={evaluation.checks} showPasses />
        </div>
      </div>
    </Step>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4: Your decision                                              */
/* ------------------------------------------------------------------ */

const HEADLINE = {
  PASS: "Match: safe to buy.",
  FLAG: "Check first before buying.",
  BLOCK: "Blocked: don't buy this one.",
} as const;

export function DecisionStep({
  control,
  session,
  analysis,
  selectedId,
  onSelect,
  onChangeRules,
}: {
  control: StepControl;
  session: SessionView;
  analysis: Analysis;
  selectedId: string | null;
  onSelect: (listingId: string) => void;
  onChangeRules: () => void;
}) {
  const { subject, alternative } = analysis;
  const req = session.contract.requirements;

  if (!subject) {
    return (
      <Step control={control} title="Your decision" subtitle="No product to decide on.">
        <div className="space-y-4 p-5 sm:p-6">
          <p className="border-l-2 border-flag-icon pl-4 text-sm text-ink-2">
            No laptop follows all your rules. PACT won&apos;t buy something that breaks them.
          </p>
          <Button id="decision-primary" onClick={onChangeRules}>
            Change my requirements
          </Button>
        </div>
      </Step>
    );
  }

  const v = subject.evaluation.verdict;
  const issues = subject.evaluation.checks.filter((c) => c.status !== "pass");
  const blocks = issues.filter((c) => c.status === "block");
  const flags = issues.filter((c) => c.status === "flag");
  const Icon = v === "PASS" ? CheckCircle2 : v === "FLAG" ? AlertTriangle : ShieldX;
  const tone =
    v === "PASS"
      ? "border-pass bg-pass-soft text-pass"
      : v === "FLAG"
        ? "border-flag-icon bg-flag-soft text-flag"
        : "border-block bg-block-soft text-block";

  const explanation =
    v === "PASS"
      ? `${subject.listing.title} follows all ${subject.evaluation.checks.length} of your rules. It costs ${money(subject.total, subject.listing.checkout.currency)}, ${money(req.maxTotal - subject.total)} under your budget.`
      : v === "FLAG"
        ? `${subject.listing.title} follows your rules, but needs your OK on ${joinLabels(flags.map((c) => c.label))}. You'll confirm each one at checkout.`
        : `${subject.listing.title} at ${money(subject.total, subject.listing.checkout.currency)} breaks ${blocks.length} of your rules: ${joinLabels(blocks.map((c) => c.label))}. PACT won't let it go to payment.`;

  const altIsPrimary = v === "BLOCK" && alternative;

  return (
    <Step
      control={control}
      title="Your decision"
      subtitle="PACT's verdict on the agent's pick, and what you can do about it."
      next="You review the exact price and approve it. PayPal payment only happens after that, in step 5."
    >
      <div className="space-y-6 p-5 sm:p-6">
        <div className={cn("border-l-4 px-4 py-4", tone)} role="group" aria-label="PACT's verdict">
          <div className="flex flex-wrap items-center gap-3">
            <Icon className="h-5 w-5" />
            <p className="text-lg font-semibold">{HEADLINE[v]}</p>
          </div>
          <p className="mt-2 max-w-2xl text-[15px] text-ink">{explanation}</p>
          {v !== "PASS" && <p className="mt-1 text-sm text-ink-2">The evidence is in step 3 above.</p>}
          {v !== "BLOCK" && (
            <Button id="decision-primary" className="mt-4" onClick={() => onSelect(subject.listing.id)}>
              {v === "PASS" ? "Continue to checkout" : "Review and continue"}
            </Button>
          )}
        </div>

        {alternative && (
          <section aria-labelledby="alt-title" className="border-t border-line pt-5">
            <h3 id="alt-title" className="eyebrow text-muted">
              {altIsPrimary ? "PACT's closest match" : "Or choose the best match instead"}
            </h3>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <div>
                <p className="text-lg font-semibold tracking-[-0.01em] text-ink">{alternative.listing.title}</p>
                <p className="text-sm text-muted">Sold by {alternative.listing.seller}</p>
                <p className="mt-1 flex items-start gap-1.5 text-sm text-pass">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Follows all {alternative.evaluation.checks.length} of your rules,{" "}
                    <span className="num">{money(req.maxTotal - alternative.total)}</span> under budget
                  </span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <p className="num font-mono text-2xl font-medium text-ink">{money(alternative.total)}</p>
                <Button
                  id={altIsPrimary ? "decision-primary" : "buy-alternative"}
                  variant={altIsPrimary ? "primary" : "secondary"}
                  onClick={() => onSelect(alternative.listing.id)}
                >
                  {altIsPrimary ? "Buy this one instead" : "Choose this one"}
                </Button>
              </div>
            </div>
          </section>
        )}

        {v === "BLOCK" && !alternative && (
          <div className="border-t border-line pt-5">
            <p className="max-w-xl text-sm text-ink-2">
              No other laptop follows all your rules either. You can relax a requirement, like the budget, and run the
              check again.
            </p>
            <Button id="decision-primary" className="mt-3" onClick={onChangeRules}>
              Change my requirements
            </Button>
          </div>
        )}

        <Details summary={`Compare all ${analysis.listingCount} listings PACT checked`} className="border-t border-line pt-4">
          <ListingsBody session={session} selectedId={selectedId} onSelect={onSelect} />
        </Details>
      </div>
    </Step>
  );
}
