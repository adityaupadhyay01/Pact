"use client";

import { AlertTriangle, CheckCircle2, EyeOff, ShieldX } from "lucide-react";
import { ChecksList } from "./Checks";
import { ListingsBody } from "./ListingsPanel";
import { joinLabels, requirementTerms, sourceLabel, type Analysis } from "./flow";
import { Badge, Button, Details, Step, type StepControl, cn, money, shortHash } from "./ui";
import type { SessionView } from "./api";
import type { ProductRecord } from "@/lib/catalog/types";

const price = (p: ProductRecord) => money(p.offer.price, p.offer.currency);

function SourceTag({ p }: { p: ProductRecord }) {
  const test = p.synthetic !== null || p.provider === "test-store";
  return (
    <Badge className={test ? "border-flag-line bg-flag-soft text-flag" : "border-line text-muted"}>{sourceLabel(p)}</Badge>
  );
}

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
  const { agent, candidateCount } = analysis;
  const d = session.discovery;
  const where = d?.provider === "test-store" ? "the test store" : "the Channel3 catalog";
  return (
    <Step
      control={control}
      title="Product discovery"
      subtitle={
        agent
          ? `Your Shopping Agent looked at ${candidateCount} products from ${where} and picked one. It hasn't bought anything.`
          : `PACT searched ${where} for “${d?.query ?? session.contract.requirements.searchQuery}”.`
      }
    >
      <div className="p-5 sm:p-6">
        {d && (
          <p className="mb-4 text-xs text-muted">
            <span className={d.provider === "test-store" ? "eyebrow mr-1.5 text-flag" : "eyebrow mr-1.5 text-ink-2"}>
              {d.provider === "test-store" ? "Test data" : "Live catalog data"}
            </span>
            {d.provider === "test-store"
              ? "Fictional products from PACT's test store."
              : `Channel3 search at ${new Date(d.retrievedAt).toLocaleTimeString()}, US merchants, USD. Prices here are from the search; PACT re-fetches the product before checking it and again before you approve.`}
          </p>
        )}
        {agent ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-labelledby="picked-title">
              <h3 id="picked-title" className="eyebrow text-muted">
                The Shopping Agent picked
              </h3>
              <p className="mt-2 text-xl font-semibold tracking-[-0.01em] text-ink">{agent.record.title}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                Sold on {agent.record.offer.domain}
                <SourceTag p={agent.record} />
              </p>
              <p className="num mt-3 font-mono text-2xl font-medium text-ink">
                {price(agent.record)}
                <span className="ml-2 font-sans text-sm font-normal text-muted">item price</span>
              </p>
              <figure className="mt-5 border-l-2 border-line-strong pl-3">
                <figcaption className="eyebrow text-faint">What the agent told you</figcaption>
                <blockquote className="mt-1 text-[15px] italic text-ink-2">“{agent.summary}”</blockquote>
              </figure>
            </section>
            <section aria-labelledby="why-title">
              <h3 id="why-title" className="eyebrow text-muted">
                How it chose
              </h3>
              <ol className="mt-2 border-t border-line">
                {agent.reasons.map((r, i) => (
                  <li key={i} className="flex gap-3 border-b border-line py-2.5 text-sm text-ink-2">
                    <span className="num font-mono text-faint">{String(i + 1).padStart(2, "0")}</span>
                    {r}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-sm text-muted">
                {agent.engine === "gemini" ? "The agent is Gemini" : "The agent is a simple test agent"}. It reads the whole
                product page, including text shoppers can&apos;t see, and nobody checks its work. That&apos;s PACT&apos;s job
                in the next step.
              </p>
            </section>
          </div>
        ) : (
          <p className="max-w-xl text-sm text-ink-2">
            No in-stock products came back for this search. Try different words or a higher budget.
          </p>
        )}
      </div>
    </Step>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: PACT Inspector                                             */
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
      <Step control={control} title="PACT Inspector" subtitle="There was no product to verify.">
        <p className="p-5 text-sm text-ink-2 sm:p-6">The search found nothing, so there is nothing to compare.</p>
      </Step>
    );
  }
  const { record, evaluation, injection, facts, evidence } = subject;
  const hiddenFindings = injection.findings.filter((f) => f.location === "hidden");
  const broken = evaluation.checks.filter((c) => c.status !== "pass").length;
  const claims = session.agent?.claims ?? [];

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
          <p className="font-medium text-ink">{record.title}</p>
          <p className="text-muted">{record.offer.domain}</p>
          <p className="mt-1">
            <SourceTag p={record} />
          </p>
          {(record.hiddenText.length > 0 || hiddenFindings.length > 0) && (
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
      body:
        agent && agent.record.id === record.id ? (
          <>
            <p className="italic">“{agent.summary}”</p>
            {claims.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                {claims.length} specific {claims.length === 1 ? "claim" : "claims"} checked against the listing
              </p>
            )}
          </>
        ) : (
          <p className="text-muted">No claim to compare.</p>
        ),
    },
    {
      n: "4",
      title: "What you'd pay",
      body: (
        <>
          <p className="num font-mono text-lg font-medium text-ink">{price(record)}</p>
          <p className="text-muted">Item price only. Shipping and tax are not verified.</p>
        </>
      ),
    },
  ];

  return (
    <Step
      control={control}
      title="PACT Inspector"
      subtitle={`PACT lines up four things for ${record.title}: your request, the seller's listing, what the agent told you and what you'd pay.`}
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
            {broken === 0 ? `All ${evaluation.checks.length} checks passed.` : `${broken} of ${evaluation.checks.length} checks need attention.`}
          </span>
        </h3>
        <div className="mt-2">
          <ChecksList checks={evaluation.checks} showPasses />
        </div>

        <Details summary="Show details" className="mt-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="eyebrow text-faint">What PACT read on the listing</p>
              <dl className="mt-2 divide-y divide-line border-y border-line text-sm">
                {r.constraints.map((c) => {
                  const f = facts[c.id];
                  return (
                    <div key={c.id} className="flex items-start justify-between gap-3 px-1 py-2">
                      <dt className="text-muted">{c.label}</dt>
                      <dd className="text-right">
                        {f ? (
                          <>
                            <span className="font-medium text-ink">
                              {f.value ?? "Yes"}
                              {f.unit ? ` ${f.unit}` : ""}
                            </span>
                            <span className="block text-xs text-muted">
                              “{f.quote}” ({f.source === "catalog_field" ? "catalog field" : "read from text"})
                            </span>
                          </>
                        ) : (
                          <span className="text-flag">Not stated</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
                {r.constraints.length === 0 && <p className="py-2 text-muted">No specific requirements to read.</p>}
              </dl>
              <p className="mt-2 text-xs text-muted">
                Read by{" "}
                {subject.reader === "gemini"
                  ? "Gemini"
                  : subject.reader === "test"
                    ? "the test-store reader (no AI)"
                    : "catalog fields only"}
                . Every fact must quote the listing word for word, or PACT ignores it.
                {subject.rejected.length > 0 && ` ${subject.rejected.length} unsupported claim(s) were ignored.`}
              </p>
            </div>
            <div>
              <p className="eyebrow text-faint">Listing text PACT checked</p>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap border-l-2 border-line-strong bg-surface-2 px-3 py-2.5 font-mono text-xs text-ink-2">
                {evidence.text}
              </pre>
              <p className="num mt-2 text-xs text-muted">
                Retrieved {new Date(evidence.retrievedAt).toLocaleString()}, fingerprint{" "}
                <span className="font-mono">{shortHash(evidence.hash)}</span>
              </p>
              {record.synthetic && <p className="mt-1 text-xs text-flag">TEST: {record.synthetic.note}</p>}
            </div>
          </div>
        </Details>
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
  onSelect: (productId: string) => void;
  onChangeRules: () => void;
}) {
  const { subject, alternative, checked, unchecked } = analysis;
  const budget = session.contract.requirements.budget;

  if (!subject) {
    return (
      <Step control={control} title="Your decision" subtitle="No product to decide on.">
        <div className="space-y-4 p-5 sm:p-6">
          <p className="border-l-2 border-flag-icon pl-4 text-sm text-ink-2">
            Nothing was found for your requirements. PACT won&apos;t buy something that breaks them.
          </p>
          <Button id="decision-primary" onClick={onChangeRules}>
            Change my requirements
          </Button>
        </div>
      </Step>
    );
  }

  const ev = subject.evaluation;
  const v = ev.verdict;
  const issues = ev.checks.filter((c) => c.status !== "pass");
  const blocks = issues.filter((c) => c.status === "block");
  const flags = issues.filter((c) => c.status === "flag");
  const Icon = v === "PASS" ? CheckCircle2 : v === "FLAG" ? AlertTriangle : ShieldX;
  const tone =
    v === "PASS"
      ? "border-pass bg-pass-soft text-pass"
      : v === "FLAG"
        ? "border-flag-icon bg-flag-soft text-flag"
        : "border-block bg-block-soft text-block";
  const title = subject.record.title;
  const cost = price(subject.record);
  const under = (x: { record: ProductRecord }) =>
    budget && budget.currency === x.record.offer.currency && budget.max >= x.record.offer.price
      ? `, ${money(budget.max - x.record.offer.price, budget.currency)} under your budget`
      : "";

  const explanation =
    v === "PASS"
      ? `${title} passes all ${ev.checks.length} checks. It costs ${cost}${under(subject)}.`
      : v === "FLAG"
        ? `${title} doesn't break your requirements, but needs your OK on ${joinLabels(flags.map((c) => c.label))}. You'll confirm each one at checkout.`
        : `${title} at ${cost} fails ${blocks.length} ${blocks.length === 1 ? "check" : "checks"}: ${joinLabels(blocks.map((c) => c.label))}. PACT won't let it go to payment.`;

  const altIsPrimary = v === "BLOCK" && alternative;

  return (
    <Step
      control={control}
      title="Your decision"
      subtitle="PACT's verdict on the agent's pick, and what you can do about it."
      next="You review the item price and approve it. PayPal payment only happens after that, in step 5."
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
            <Button id="decision-primary" className="mt-4" onClick={() => onSelect(subject.productId)}>
              {v === "PASS" ? "Continue to checkout" : "Review and continue"}
            </Button>
          )}
        </div>

        {alternative && (
          <section aria-labelledby="alt-title" className="border-t border-line pt-5">
            <h3 id="alt-title" className="eyebrow text-muted">
              {altIsPrimary ? "PACT's closest match" : "Or choose PACT's best match instead"}
            </h3>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <div>
                <p className="text-lg font-semibold tracking-[-0.01em] text-ink">{alternative.record.title}</p>
                <p className="text-sm text-muted">Sold on {alternative.record.offer.domain}</p>
                <p className="mt-1 flex items-start gap-1.5 text-sm text-pass">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Passes all {alternative.evaluation.checks.length} checks{under(alternative)}
                  </span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <p className="num font-mono text-2xl font-medium text-ink">{price(alternative.record)}</p>
                <Button
                  id={altIsPrimary ? "decision-primary" : "buy-alternative"}
                  variant={altIsPrimary ? "primary" : "secondary"}
                  onClick={() => onSelect(alternative.productId)}
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
              PACT didn&apos;t find another product that passes every check. You can relax a requirement, like the budget,
              and run the check again.
            </p>
            <Button id="decision-primary" className="mt-3" onClick={onChangeRules}>
              Change my requirements
            </Button>
          </div>
        )}

        {unchecked.length > 0 && (
          <p className="border-t border-line pt-4 text-sm text-muted">
            {unchecked.length} other {unchecked.length === 1 ? "product was" : "products were"} found but not checked (the AI
            service was busy). PACT never offers an unchecked product for payment.
          </p>
        )}

        {checked.length > 1 && (
          <Details summary={`Compare all ${checked.length} products PACT checked`} className="border-t border-line pt-4">
            <ListingsBody session={session} checked={checked} selectedId={selectedId} onSelect={onSelect} />
          </Details>
        )}
      </div>
    </Step>
  );
}
