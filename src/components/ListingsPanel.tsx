"use client";

import { useState } from "react";
import { ChevronDown, EyeOff } from "lucide-react";
import { getListing } from "@/lib/marketplace";
import { hiddenSegments, visibleText } from "@/lib/injection";
import { AuditGrid } from "./AuditGrid";
import { ChecksList } from "./Checks";
import { Button, Details, VERDICT_LABEL, VerdictBadge, cn } from "./ui";
import type { SessionView } from "./api";

const FACT_LABEL = { ramGb: "RAM", storageGb: "Storage", warrantyMonths: "Warranty", condition: "Condition" } as const;
const fmtFact = (k: keyof typeof FACT_LABEL, v: unknown) =>
  k === "ramGb" ? `${v}GB` : k === "storageGb" ? (Number(v) >= 1000 ? `${Number(v) / 1000}TB` : `${v}GB`) : k === "warrantyMonths" ? `${v} months` : String(v);

/** Every listing PACT checked, as a list or an AG Grid table. Lives inside the decision step. */
export function ListingsBody({
  session,
  selectedId,
  onSelect,
}: {
  session: SessionView;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [spoilers, setSpoilers] = useState(false);
  const [mode, setMode] = useState<"list" | "table">("list");
  const s = session.search;
  if (!s) return null;

  const order = { PASS: 0, FLAG: 1, BLOCK: 2 };
  const results = [...s.results].sort(
    (a, b) => order[a.evaluation.verdict] - order[b.evaluation.verdict] || a.evaluation.totalCents - b.evaluation.totalCents,
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <p className="max-w-xl text-sm text-muted">
          “{VERDICT_LABEL.PASS}” follows all your rules. “{VERDICT_LABEL.FLAG}” needs your OK on something. “
          {VERDICT_LABEL.BLOCK}” breaks a rule.
        </p>
        <div role="group" aria-label="View as" className="inline-flex rounded-control border border-line-strong p-0.5 text-sm">
          {(["list", "table"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-8 rounded-[3px] px-3 py-1.5 font-medium capitalize",
                mode === m ? "bg-brand text-white" : "text-muted hover:bg-surface-3",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === "table" && (
        <div>
          <AuditGrid results={s.results} onSelect={onSelect} />
        </div>
      )}

      {mode === "list" && (
        <>
          <ul className="divide-y divide-line">
            {results.map((r) => {
              const l = getListing(r.listingId)!;
              const isOpen = open === r.listingId;
              const issues = r.evaluation.checks.filter((c) => c.status !== "pass");
              const hidden = hiddenSegments(l.html);
              const price = new Intl.NumberFormat("en-US", { style: "currency", currency: l.checkout.currency }).format(
                r.evaluation.totalCents / 100,
              );
              return (
                <li key={r.listingId} className={cn(selectedId === r.listingId && "bg-surface-2")}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={`listing-${r.listingId}`}
                    onClick={() => setOpen(isOpen ? null : r.listingId)}
                    className="flex w-full items-center gap-3 px-2 py-3.5 text-left hover:bg-surface-2"
                  >
                    <span className="hidden w-28 shrink-0 sm:block">
                      <VerdictBadge verdict={r.evaluation.verdict} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mb-1 block sm:hidden">
                        <VerdictBadge verdict={r.evaluation.verdict} />
                      </span>
                      <span className="block font-medium text-ink sm:truncate">{l.title}</span>
                      <span className="block text-sm text-muted sm:truncate">
                        {issues.length ? issues.map((c) => c.label).join(", ") : "Follows all your rules"}
                      </span>
                      {spoilers && l.trap && <span className="block text-sm text-accent-ink">Trap: {l.trap}</span>}
                    </span>
                    <span className="num text-right font-mono font-medium text-ink">{price}</span>
                    <ChevronDown className={cn("h-4 w-4 shrink-0 text-faint transition", isOpen && "rotate-180")} />
                  </button>

                  {isOpen && (
                    <div id={`listing-${r.listingId}`} className="space-y-4 px-2 pb-5">
                      <ChecksList checks={r.evaluation.checks} />

                      {hidden.length > 0 && (
                        <div className="border-l-2 border-block bg-block-soft px-3 py-2.5">
                          <p className="flex items-center gap-1.5 text-sm font-medium text-block">
                            <EyeOff className="h-4 w-4" /> Hidden text on this page (buyers can&apos;t see it, AI agents can)
                          </p>
                          {hidden.map((h, i) => (
                            <p key={i} className="mt-1 text-sm text-block">“{h}”</p>
                          ))}
                        </div>
                      )}

                      {r.evaluation.verdict !== "BLOCK" ? (
                        <Button variant="secondary" onClick={() => onSelect(r.listingId)}>
                          Buy this one
                        </Button>
                      ) : (
                        <p className="text-sm text-muted">You can&apos;t buy this one: it breaks your rules.</p>
                      )}

                      <Details summary="Show what we read on the listing">
                        <div className="grid gap-4 lg:grid-cols-2">
                          <dl className="divide-y divide-line border-y border-line text-sm">
                            {(Object.keys(FACT_LABEL) as (keyof typeof FACT_LABEL)[]).map((k) => {
                              const f = r.facts[k];
                              return (
                                <div key={k} className="flex items-start justify-between gap-3 px-3 py-2">
                                  <dt className="text-muted">{FACT_LABEL[k]}</dt>
                                  <dd className="text-right">
                                    {f ? (
                                      <>
                                        <span className="font-medium text-ink">{fmtFact(k, f.value)}</span>
                                        <span className="block text-xs text-muted">“{f.quote}”</span>
                                      </>
                                    ) : (
                                      <span className="text-flag">Not mentioned</span>
                                    )}
                                  </dd>
                                </div>
                              );
                            })}
                          </dl>
                          <div>
                            <p className="border-l-2 border-line-strong bg-surface-2 px-3 py-2.5 text-sm text-ink-2">{visibleText(l.html)}</p>
                            <p className="mt-2 text-xs text-muted">
                              Read by {r.engine === "gemini" ? "Gemini" : "the rule-based reader"}. Every fact must quote
                              the listing word for word, or we ignore it.
                              {r.rejectedFacts.length > 0 && ` ${r.rejectedFacts.length} unsupported claim(s) were ignored.`}
                            </p>
                          </div>
                        </div>
                      </Details>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <label className="flex cursor-pointer items-center gap-2 px-2 py-3 text-sm text-muted">
            <input type="checkbox" checked={spoilers} onChange={(e) => setSpoilers(e.target.checked)} />
            Show the traps we planted in this demo store
          </label>
        </>
      )}
    </div>
  );
}
