"use client";

import { useState } from "react";
import { ChevronDown, EyeOff } from "lucide-react";
import { AuditGrid } from "./AuditGrid";
import { ChecksList } from "./Checks";
import { sourceLabel, type Verified } from "./flow";
import { Button, Details, VERDICT_LABEL, VerdictBadge, cn, money } from "./ui";
import type { SessionView } from "./api";

/** Every product PACT checked, as a list or an AG Grid table. Lives inside the decision step. */
export function ListingsBody({
  session,
  checked,
  selectedId,
  onSelect,
}: {
  session: SessionView;
  checked: Verified[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "table">("list");
  const constraints = session.contract.requirements.constraints;

  const order = { PASS: 0, FLAG: 1, BLOCK: 2 };
  const results = [...checked].sort(
    (a, b) => order[a.evaluation.verdict] - order[b.evaluation.verdict] || a.evaluation.totalCents - b.evaluation.totalCents,
  );
  const agentPick = session.agent?.chosenId;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <p className="max-w-xl text-sm text-muted">
          “{VERDICT_LABEL.PASS}” passes every check. “{VERDICT_LABEL.FLAG}” needs your OK on something. “
          {VERDICT_LABEL.BLOCK}” breaks a requirement.
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

      {mode === "table" && <AuditGrid results={checked} constraints={constraints} onSelect={onSelect} />}

      {mode === "list" && (
        <ul className="divide-y divide-line">
          {results.map((r) => {
            const p = r.record;
            const isOpen = open === r.productId;
            const issues = r.evaluation.checks.filter((c) => c.status !== "pass");
            const hidden = r.injection.findings.filter((f) => f.location === "hidden");
            return (
              <li key={r.productId} className={cn(selectedId === r.productId && "bg-surface-2")}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`listing-${r.productId}`}
                  onClick={() => setOpen(isOpen ? null : r.productId)}
                  className="flex w-full items-center gap-3 px-2 py-3.5 text-left hover:bg-surface-2"
                >
                  <span className="hidden w-28 shrink-0 sm:block">
                    <VerdictBadge verdict={r.evaluation.verdict} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="mb-1 block sm:hidden">
                      <VerdictBadge verdict={r.evaluation.verdict} />
                    </span>
                    <span className="block font-medium text-ink sm:truncate">
                      {p.title}
                      {r.productId === agentPick && <span className="ml-2 text-xs font-normal text-muted">(agent&apos;s pick)</span>}
                    </span>
                    <span className="block text-sm text-muted sm:truncate">
                      {p.offer.domain} · {issues.length ? issues.map((c) => c.label).join(", ") : "Passes every check"}
                    </span>
                  </span>
                  <span className="num text-right font-mono font-medium text-ink">{money(p.offer.price, p.offer.currency)}</span>
                  <ChevronDown className={cn("h-4 w-4 shrink-0 text-faint transition", isOpen && "rotate-180")} />
                </button>

                {isOpen && (
                  <div id={`listing-${r.productId}`} className="space-y-4 px-2 pb-5">
                    <ChecksList checks={r.evaluation.checks} />

                    {hidden.length > 0 && (
                      <div className="border-l-2 border-block bg-block-soft px-3 py-2.5">
                        <p className="flex items-center gap-1.5 text-sm font-medium text-block">
                          <EyeOff className="h-4 w-4" /> Hidden text on this page (shoppers can&apos;t see it, AI agents can)
                        </p>
                        {hidden.map((h, i) => (
                          <p key={i} className="mt-1 text-sm text-block">
                            “{h.excerpt}”
                          </p>
                        ))}
                      </div>
                    )}

                    {r.evaluation.verdict !== "BLOCK" ? (
                      <Button variant="secondary" onClick={() => onSelect(r.productId)}>
                        Buy this one
                      </Button>
                    ) : (
                      <p className="text-sm text-muted">You can&apos;t buy this one: it breaks your requirements.</p>
                    )}

                    <Details summary="Show what PACT read">
                      <p className="text-xs text-muted">{sourceLabel(p)}</p>
                      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap border-l-2 border-line-strong bg-surface-2 px-3 py-2.5 font-mono text-xs text-ink-2">
                        {r.evidence.text}
                      </pre>
                    </Details>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
