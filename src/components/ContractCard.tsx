"use client";

import { useState } from "react";
import { Lock, PenLine, Search } from "lucide-react";
import type { Requirements } from "@/lib/contract";
import { Button, Details, Step, type StepControl, money, shortHash } from "./ui";
import type { SessionView } from "./api";

const fmtStorage = (gb: number) => (gb >= 1000 ? `${gb / 1000}TB` : `${gb}GB`);
const fmtWarranty = (m: number) => (m % 12 === 0 ? `${m / 12}-year` : `${m}-month`);

/** The buyer's binding rules as plain sentences, e.g. "At least 16GB of RAM". */
function mustHaves(r: Requirements): { label: string; value: string }[] {
  return [
    r.ramGbMin !== null ? { label: "Memory", value: `At least ${r.ramGbMin}GB of RAM` } : null,
    r.storageGbMin !== null ? { label: "Storage", value: `At least ${fmtStorage(r.storageGbMin)} of storage` } : null,
    r.warrantyMonthsMin !== null ? { label: "Warranty", value: `At least a ${fmtWarranty(r.warrantyMonthsMin)} warranty` } : null,
    {
      label: "Condition",
      value: r.condition === "new" ? "Brand new (no refurbished or used)" : "New, refurbished or used is fine",
    },
    { label: "Budget", value: `Total price up to ${money(r.maxTotal, r.currency)}, including tax, shipping and fees` },
  ].filter((x): x is { label: string; value: string } => Boolean(x));
}

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
  onRevise: (patch: Partial<Requirements>) => void;
  busy: string | null;
}) {
  const c = session.contract;
  const r = c.requirements;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r);
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <Step
      control={control}
      title="Your requirements"
      subtitle={
        session.approved
          ? "Your agent may only buy something that follows these."
          : "This is what PACT understood from your request. Check it, fix anything wrong, then confirm."
      }
      next="Your shopping agent searches the store and picks a product. PACT then checks that pick against these requirements. Nothing is bought or charged."
    >
      <div className="p-5 sm:p-6">
        {!editing ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section aria-labelledby="must-have-title">
              <h3 id="must-have-title" className="eyebrow flex items-center gap-1.5 text-ink">
                <Lock className="h-3 w-3" /> Must have
              </h3>
              <dl className="mt-3 border-t border-line">
                {mustHaves(r).map((row) => (
                  <div key={row.label} className="grid gap-x-6 gap-y-0.5 border-b border-line py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <dt className="text-sm text-muted">{row.label}</dt>
                    <dd className="num text-[15px] text-ink">{row.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-muted">
                If a product breaks any of these, PACT blocks it. If you change one later, you confirm again.
              </p>
            </section>
            <section aria-labelledby="nice-title">
              <h3 id="nice-title" className="eyebrow text-muted">
                Nice to have
              </h3>
              {r.preferences.length ? (
                <ul className="mt-3 border-t border-line">
                  {r.preferences.map((p) => (
                    <li key={p} className="border-b border-line py-2.5 text-[15px] text-ink-2">
                      {p}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 border-t border-line pt-2.5 text-sm text-muted">
                  None. Add preferences like “lightweight” if you have them. They never block a purchase.
                </p>
              )}
            </section>
          </div>
        ) : (
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="eyebrow mb-3 text-ink">Edit your requirements</legend>
            <Field label="Minimum RAM (GB)">
              <input type="number" min={1} className="input num" defaultValue={draft.ramGbMin ?? ""}
                onChange={(e) => setDraft({ ...draft, ramGbMin: num(e.target.value) })} />
            </Field>
            <Field label="Minimum storage (GB)">
              <input type="number" min={1} className="input num" defaultValue={draft.storageGbMin ?? ""}
                onChange={(e) => setDraft({ ...draft, storageGbMin: num(e.target.value) })} />
            </Field>
            <Field label="Minimum warranty (months)">
              <input type="number" min={0} className="input num" defaultValue={draft.warrantyMonthsMin ?? ""}
                onChange={(e) => setDraft({ ...draft, warrantyMonthsMin: num(e.target.value) })} />
            </Field>
            <Field label="Max total price">
              <input type="number" min={1} className="input num" defaultValue={draft.maxTotal}
                onChange={(e) => setDraft({ ...draft, maxTotal: Number(e.target.value) || draft.maxTotal })} />
            </Field>
            <Field label="Condition">
              <select className="input" defaultValue={draft.condition}
                onChange={(e) => setDraft({ ...draft, condition: e.target.value as "new" | "any" })}>
                <option value="new">Brand new only</option>
                <option value="any">Refurbished or used is fine</option>
              </select>
            </Field>
            <Field label="Nice to have (optional, comma separated)">
              <input className="input" defaultValue={draft.preferences.join(", ")} placeholder="e.g. lightweight"
                onChange={(e) => setDraft({ ...draft, preferences: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Field>
          </fieldset>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {!editing ? (
            <>
              {!session.approved && (
                <Button id="approve-contract" onClick={onApprove} loading={busy === "approve"}>
                  <Search className="h-4 w-4" /> {busy === "approve" ? "Running the check…" : "Looks right, run the check"}
                </Button>
              )}
              <Button variant="secondary" onClick={() => { setDraft(r); setEditing(true); }}>
                <PenLine className="h-4 w-4" /> Change requirements
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => { onRevise(draft); setEditing(false); }} loading={busy === "revise"}>
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </>
          )}
        </div>

        <Details summary="Show details" className="mt-6">
          <dl className="grid gap-x-6 gap-y-1.5 border-l-2 border-line pl-3 text-xs text-muted sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="eyebrow text-faint">Your words</dt>
            <dd>“{session.requestText}”</dd>
            <dt className="eyebrow text-faint">Read by</dt>
            <dd>{session.parseEngine === "gemini" ? "Gemini" : "Rule-based parser (no Gemini key set)"}</dd>
            <dt className="eyebrow text-faint">Version</dt>
            <dd className="num">
              {c.version}
              {session.contracts.length > 1 && ` (${session.contracts.length - 1} earlier)`}
            </dd>
            <dt className="eyebrow text-faint">Fingerprint</dt>
            <dd>
              <span className="num font-mono">{shortHash(c.hash)}</span>. Your confirmation is tied to this exact
              version, so nobody can change the rules after you agree.
            </dd>
          </dl>
        </Details>
      </div>
    </Step>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium text-ink-2">
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
