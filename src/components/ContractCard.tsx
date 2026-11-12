"use client";

import { useState } from "react";
import { Lock, PenLine, Search, Trash2 } from "lucide-react";
import type { Constraint } from "@/lib/contract";
import { describeRequirement } from "@/lib/rules";
import { Button, Details, Step, type StepControl, money, shortHash } from "./ui";
import type { SessionView } from "./api";

// US merchants and PayPal Sandbox in US dollars only in this version.
const CURRENCIES = ["USD"];

export function ContractCard({
  control,
  session,
  onApprove,
  onRevise,
  busy,
}: {
  control: StepControl;
  session: SessionView;
  onApprove: () => void;
  onRevise: (patch: { budget?: { max: number; currency: string } | null; constraints?: Constraint[] }) => void;
  busy: string | null;
}) {
  const c = session.contract;
  const r = c.requirements;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Constraint[]>(r.constraints);
  const [budgetMax, setBudgetMax] = useState(r.budget ? String(r.budget.max) : "");
  const [currency, setCurrency] = useState(r.budget?.currency ?? "USD");
  const must = r.constraints.filter((x) => x.mandatory);
  const nice = r.constraints.filter((x) => !x.mandatory);
  const needsBudget = !r.budget;
  const budgetValue = Number(budgetMax);
  const budgetValid = budgetMax.trim() !== "" && Number.isFinite(budgetValue) && budgetValue > 0;

  const saveBudget = () => budgetValid && onRevise({ budget: { max: budgetValue, currency } });

  const row = (x: Constraint) => (
    <div key={x.id} className="grid gap-x-6 gap-y-0.5 border-b border-line py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted">{x.label}</dt>
      <dd>
        <span className="num text-[15px] text-ink">{describeRequirement(x)}</span>
        <span className="mt-0.5 block text-xs text-muted">
          {x.origin === "edited" ? "Changed by you" : <>You said: “{x.userQuote}”</>}
        </span>
      </dd>
    </div>
  );

  return (
    <Step
      control={control}
      title="Your requirements"
      subtitle={
        session.approved
          ? "Your agent may only buy something that follows these."
          : "This is what PACT understood from your request. Every item quotes your own words. Check it, fix anything wrong, then confirm."
      }
      next="PACT searches for products, your shopping agent picks one, and PACT checks that pick against these requirements. Nothing is bought or charged."
    >
      <div className="p-5 sm:p-6">
        {!editing ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section aria-labelledby="must-have-title">
              <h3 id="must-have-title" className="eyebrow flex items-center gap-1.5 text-ink">
                <Lock className="h-3 w-3" /> Must have
              </h3>
              <dl className="mt-3 border-t border-line">
                <div className="border-b border-line py-2.5 sm:grid sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-6">
                  <dt className="text-sm text-muted">Product</dt>
                  <dd className="text-[15px] text-ink">{r.product}</dd>
                </div>
                {must.map(row)}
                <div className="grid gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <dt className="text-sm text-muted">Budget</dt>
                  <dd>
                    {r.budget ? (
                      <>
                        <span className="num text-[15px] text-ink">Item price up to {money(r.budget.max, r.budget.currency)}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {r.budget.origin === "edited" ? "Set by you" : <>You said: “{r.budget.userQuote}”</>}. Shipping, tax and the
                          merchant&apos;s checkout total are not verified.
                        </span>
                      </>
                    ) : (
                      <form
                        className="mt-1 flex flex-wrap items-end gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveBudget();
                        }}
                      >
                        <p className="w-full text-sm text-flag">
                          You didn&apos;t mention a budget. PACT won&apos;t guess one: what&apos;s the most you want to pay?
                        </p>
                        <label className="text-sm">
                          <span className="sr-only">Maximum item price</span>
                          <input
                            id="budget-input"
                            type="number"
                            min={0.01}
                            step="0.01"
                            inputMode="decimal"
                            className="input num w-32"
                            value={budgetMax}
                            onChange={(e) => setBudgetMax(e.target.value)}
                            placeholder="e.g. 50"
                          />
                        </label>
                        <label className="text-sm">
                          <span className="sr-only">Currency</span>
                          <select className="input w-24" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                            {CURRENCIES.map((cur) => (
                              <option key={cur}>{cur}</option>
                            ))}
                          </select>
                        </label>
                        <Button type="submit" variant="secondary" disabled={!budgetValid} loading={busy === "revise"}>
                          Set budget
                        </Button>
                      </form>
                    )}
                  </dd>
                </div>
              </dl>
              {must.length === 0 && (
                <p className="mt-2 text-xs text-muted">
                  No specific must-haves were found in your request, so PACT will only check the price, availability and the
                  seller&apos;s text.
                </p>
              )}
            </section>
            <section aria-labelledby="nice-title">
              <h3 id="nice-title" className="eyebrow text-muted">
                Nice to have
              </h3>
              {nice.length ? (
                <dl className="mt-3 border-t border-line">{nice.map(row)}</dl>
              ) : (
                <p className="mt-3 border-t border-line pt-2.5 text-sm text-muted">None. Nice-to-haves never block a purchase.</p>
              )}
            </section>
          </div>
        ) : (
          <fieldset className="space-y-4">
            <legend className="eyebrow mb-1 text-ink">Edit your requirements</legend>
            {draft.length === 0 && <p className="text-sm text-muted">No requirements to edit.</p>}
            {draft.map((x, i) => (
              <div key={x.id} className="grid items-end gap-3 border-b border-line pb-3 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_auto]">
                <p className="text-sm text-ink-2">
                  {x.label} <span className="text-muted">({x.operator === "present" ? "has" : x.operator})</span>
                </p>
                <label className="text-xs text-muted">
                  Value
                  <input
                    className="input mt-1"
                    disabled={x.operator === "present"}
                    defaultValue={x.value ?? ""}
                    aria-label={`${x.label} value`}
                    onChange={(e) => setDraft(draft.map((y, j) => (j === i ? { ...y, value: e.target.value || null } : y)))}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    checked={x.mandatory}
                    onChange={(e) => setDraft(draft.map((y, j) => (j === i ? { ...y, mandatory: e.target.checked } : y)))}
                  />
                  Must have
                </label>
                <Button variant="ghost" aria-label={`Remove ${x.label}`} onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <label className="block max-w-xs text-sm font-medium text-ink-2">
              Max item price
              <div className="mt-1.5 flex gap-2">
                <input
                  type="number"
                  min={0.01}
                  step="0.01"
                  className="input num"
                  value={budgetMax}
                  onChange={(e) => setBudgetMax(e.target.value)}
                />
                <select className="input w-24" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
                  {CURRENCIES.map((cur) => (
                    <option key={cur}>{cur}</option>
                  ))}
                </select>
              </div>
            </label>
          </fieldset>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {!editing ? (
            <>
              {!session.approved && (
                <Button id="approve-contract" onClick={onApprove} loading={busy === "approve"} disabled={needsBudget}>
                  <Search className="h-4 w-4" /> {busy === "approve" ? "Starting the check…" : "Looks right, run the check"}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(r.constraints);
                  setEditing(true);
                }}
              >
                <PenLine className="h-4 w-4" /> Change requirements
              </Button>
              {needsBudget && <span className="text-sm text-muted">Set a budget to continue.</span>}
            </>
          ) : (
            <>
              <Button
                onClick={() => {
                  onRevise({
                    constraints: draft,
                    ...(budgetValid ? { budget: { max: budgetValue, currency } } : {}),
                  });
                  setEditing(false);
                }}
                loading={busy === "revise"}
              >
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>

        <Details summary="Show details" className="mt-6">
          <dl className="grid gap-x-6 gap-y-1.5 border-l-2 border-line pl-3 text-xs text-muted sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="eyebrow text-faint">Your words</dt>
            <dd>“{session.requestText}”</dd>
            <dt className="eyebrow text-faint">Read by</dt>
            <dd>{session.intent.engine === "gemini" ? "Gemini (Google AI)" : "Test-store reader (no AI, laptops only)"}</dd>
            {session.intent.dropped.length > 0 && (
              <>
                <dt className="eyebrow text-faint">Ignored</dt>
                <dd>
                  {session.intent.dropped.map((d) => `${d.what} (${d.reason})`).join("; ")}. PACT only keeps what you actually
                  said.
                </dd>
              </>
            )}
            <dt className="eyebrow text-faint">Search text</dt>
            <dd>“{r.searchQuery}”</dd>
            <dt className="eyebrow text-faint">Version</dt>
            <dd className="num">
              {c.version}, fingerprint <span className="font-mono">{shortHash(c.hash)}</span>. Your confirmation is tied to this
              exact version.
            </dd>
          </dl>
        </Details>
      </div>
    </Step>
  );
}
