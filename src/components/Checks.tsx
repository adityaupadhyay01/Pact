"use client";

import type { Check } from "@/lib/rules";
import { Details, StatusIcon, cn } from "./ui";

const RAIL: Record<Check["status"], string> = {
  pass: "border-l-pass-line",
  flag: "border-l-flag-icon",
  block: "border-l-block",
};

/**
 * One check as a comparison row: what you asked for, what PACT found, and the
 * decision. On wide screens the three line up as columns; on phones they stack.
 */
function CheckRow({ c }: { c: Check }) {
  const asked = c.id.startsWith("order-") ? "You confirmed" : "You asked";
  return (
    <li
      className={cn(
        "grid gap-x-6 gap-y-1 border-b border-l-2 border-b-line py-3 pl-3 pr-1 last:border-b-0 @2xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_7.5rem]",
        RAIL[c.status],
      )}
    >
      <div className="min-w-0">
        <p className="font-medium text-ink">{c.label}</p>
        <p className="mt-0.5 text-sm text-muted">{c.detail}</p>
        {c.evidence && (
          <p className="mt-1.5 text-xs text-muted">
            <span className="eyebrow text-faint">{c.id === "agent-claim" ? "The agent said" : "From the listing"}</span>{" "}
            <span className="italic">“{c.evidence}”</span>
          </p>
        )}
      </div>
      <div className="text-sm">
        {c.expected && (
          <>
            <span className="eyebrow block text-faint @2xl:sr-only">{asked}</span>
            <span className="num text-ink-2">{c.expected}</span>
          </>
        )}
      </div>
      <div className="text-sm">
        {c.actual && (
          <>
            <span className="eyebrow block text-faint @2xl:sr-only">Found</span>
            <span className="num font-medium text-ink">{c.actual}</span>
          </>
        )}
      </div>
      <div className="@2xl:text-right">
        <StatusIcon status={c.status} withLabel />
      </div>
    </li>
  );
}

function Head({ askedLabel }: { askedLabel: string }) {
  return (
    <div
      aria-hidden="true"
      className="hidden gap-x-6 border-b border-line pb-2 pl-3.5 pr-1 @2xl:grid @2xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_7.5rem]"
    >
      <span className="eyebrow text-faint">Check</span>
      <span className="eyebrow text-faint">{askedLabel}</span>
      <span className="eyebrow text-faint">Found</span>
      <span className="eyebrow text-right text-faint">Result</span>
    </div>
  );
}

/**
 * Problems first. Passing checks are tucked behind "N checks passed" unless
 * `showPasses` is set, so people see what matters without scrolling.
 */
export function ChecksList({
  checks,
  onlyIssues,
  showPasses,
}: {
  checks: Check[];
  onlyIssues?: boolean;
  showPasses?: boolean;
}) {
  const order = { block: 0, flag: 1, pass: 2 };
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  const issues = sorted.filter((c) => c.status !== "pass");
  const passes = sorted.filter((c) => c.status === "pass");
  const askedLabel = checks.some((c) => c.id.startsWith("order-")) ? "You confirmed" : "You asked";

  const list = (items: Check[]) => (
    <ul>
      {items.map((c) => (
        <CheckRow key={c.id} c={c} />
      ))}
    </ul>
  );

  return (
    <div className="@container space-y-3">
      {issues.length > 0 && (
        <div>
          <Head askedLabel={askedLabel} />
          {list(issues)}
        </div>
      )}
      {!onlyIssues &&
        passes.length > 0 &&
        (showPasses ? (
          <div>
            {issues.length === 0 && <Head askedLabel={askedLabel} />}
            {list(passes)}
          </div>
        ) : (
          <Details summary={`${issues.length ? "" : "All "}${passes.length} ${passes.length === 1 ? "check" : "checks"} passed`}>
            <Head askedLabel={askedLabel} />
            {list(passes)}
          </Details>
        ))}
    </div>
  );
}
