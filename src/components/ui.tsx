"use client";

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion } from "motion/react";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Loader2, ShieldX } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

/* ---------- Surfaces ---------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-card border border-line bg-surface", className)}>{children}</section>;
}

/* ---------- Workflow steps ---------- */

export type StepId = "requirements" | "discovery" | "verification" | "decision" | "checkout" | "evidence";
export type StepStatus = "pending" | "active" | "completed" | "blocked";

export interface StepControl {
  id: StepId;
  n: number;
  status: StepStatus;
  expanded: boolean;
  onToggle: () => void;
  /** One-line summary shown while collapsed. */
  summary?: ReactNode;
}

export const STATUS_TEXT: Record<StepStatus, string> = {
  pending: "Not started",
  active: "In progress",
  completed: "Done",
  blocked: "Needs attention",
};

export const stepNumber = (n: number) => String(n).padStart(2, "0");

/** Step number for the progress bar: a check when done, a shield when blocked. */
export function StepMarker({ n, status, small }: { n: number; status: StepStatus; small?: boolean }) {
  const size = small ? "h-6 w-6 text-[11px]" : "h-7 w-7 text-xs";
  const style: Record<StepStatus, string> = {
    pending: "border border-line-strong text-faint",
    active: "bg-brand text-white",
    completed: "border border-pass-line bg-pass-soft text-pass",
    blocked: "bg-block-strong text-white",
  };
  return (
    <span
      aria-hidden="true"
      className={cn("num flex shrink-0 items-center justify-center rounded-full font-mono font-medium", size, style[status])}
    >
      {status === "completed" ? (
        <Check className={small ? "h-3.5 w-3.5" : "h-4 w-4"} strokeWidth={2.5} />
      ) : status === "blocked" ? (
        <ShieldX className={small ? "h-3.5 w-3.5" : "h-4 w-4"} />
      ) : (
        n
      )}
    </span>
  );
}

/** Written status for a step, so state never depends on colour alone. */
function StepState({ status }: { status: StepStatus }) {
  const style: Record<StepStatus, string> = {
    pending: "text-faint",
    active: "text-ink",
    completed: "text-pass",
    blocked: "text-block",
  };
  return (
    <span className={cn("eyebrow inline-flex items-center gap-1", style[status])}>
      {status === "completed" && <Check className="h-3 w-3" strokeWidth={3} />}
      {status === "blocked" && <ShieldX className="h-3 w-3" />}
      {status === "active" && <span className="h-1.5 w-1.5 rounded-full bg-ink" />}
      {STATUS_TEXT[status]}
    </span>
  );
}

/**
 * A collapsible workflow section (ARIA accordion pattern: a heading containing a
 * button). Collapsed content stays mounted, so form state is never lost.
 *
 * Layout: an editorial left gutter carries the step number and its written
 * state; the title, summary and body sit in the main column.
 */
export function Step({
  control,
  title,
  subtitle,
  right,
  next,
  children,
}: {
  control: StepControl;
  title: string;
  /** What is happening in this step, in one sentence. */
  subtitle?: string;
  right?: ReactNode;
  /** What happens after this step. Shown at the bottom of the active step. */
  next?: ReactNode;
  children?: ReactNode;
}) {
  const { id, n, status, expanded, onToggle, summary } = control;
  const pending = status === "pending";
  const bodyId = `step-${id}-body`;
  const open = expanded && !pending;

  return (
    <section
      id={`step-${id}`}
      aria-labelledby={`step-${id}-title`}
      className={cn(
        "scroll-mt-20 rounded-card border",
        pending ? "border-dashed border-line-strong bg-transparent" : "bg-surface",
        // The receipt records in the background; only steps that need the user get the strong border.
        status === "active" && id !== "evidence" && "border-ink/50",
        status === "active" && id === "evidence" && "border-line",
        status === "blocked" && "border-block-line",
        status === "completed" && "border-line",
      )}
    >
      <div className="grid gap-x-6 gap-y-2 px-5 py-5 sm:px-6 md:grid-cols-[8rem_minmax(0,1fr)_auto] md:items-start">
        <div className="flex items-center gap-3 md:flex-col md:items-start md:gap-1.5">
          <span className={cn("num font-mono text-sm font-medium", pending ? "text-faint" : "text-ink")} aria-hidden="true">
            {stepNumber(n)}
          </span>
          <StepState status={status} />
        </div>

        <div className="min-w-0">
          <h2 id={`step-${id}-title`} className="text-lg font-semibold leading-snug tracking-[-0.01em] text-ink">
            {pending ? (
              <span className="text-muted">{title}</span>
            ) : (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={bodyId}
                className="group inline-flex min-h-7 items-center gap-2 text-left hover:underline hover:decoration-line-strong hover:underline-offset-4"
              >
                {title}
                <ChevronDown
                  className={cn("h-4 w-4 shrink-0 text-faint transition-transform duration-200", open && "rotate-180")}
                />
                <span className="sr-only">{open ? "(hide)" : "(show)"}</span>
              </button>
            )}
            <span className="sr-only"> ({STATUS_TEXT[status]})</span>
          </h2>
          {open ? (
            subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>
          ) : (
            <div className="mt-1 text-sm text-muted">{summary ?? subtitle}</div>
          )}
        </div>

        {right && !pending && <div className="flex flex-wrap items-center gap-2 md:justify-end">{right}</div>}
      </div>

      {!pending && (
        <motion.div
          id={bodyId}
          role="region"
          aria-labelledby={`step-${id}-title`}
          hidden={!open}
          initial={false}
          animate={{ opacity: open ? 1 : 0 }}
          transition={{ duration: 0.18 }}
          className="border-t border-line md:ml-[11rem]"
        >
          {children}
          {next && status === "active" && (
            <p className="border-t border-line px-5 py-3 text-sm text-muted sm:px-6">
              <span className="eyebrow mr-2 text-ink">What happens next</span>
              {next}
            </p>
          )}
        </motion.div>
      )}
    </section>
  );
}

/* ---------- Controls ---------- */

type Variant = "primary" | "secondary" | "danger" | "ghost" | "paypal";
export function Button({
  variant = "primary",
  loading,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-brand text-white hover:bg-brand-hover",
    secondary: "border border-line-strong bg-surface text-ink hover:border-ink",
    danger: "bg-block-strong text-white hover:opacity-90",
    ghost: "text-muted hover:bg-surface-3 hover:text-ink",
    paypal: "bg-paypal text-ink hover:bg-paypal-hover",
  };
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "eyebrow inline-flex items-center gap-1 whitespace-nowrap rounded-control border px-1.5 py-0.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** "Show details" disclosure for technical information most people don't need. */
export function Details({ summary, children, className }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn("group text-sm", className)}>
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
        {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("eyebrow text-muted", className)}>{children}</p>;
}

/* ---------- Verdicts ---------- */

export type VerdictT = "PASS" | "FLAG" | "BLOCK";
export type StatusT = "pass" | "flag" | "block";

export const VERDICT_STYLE: Record<VerdictT, string> = {
  PASS: "border-pass-line bg-pass-soft text-pass",
  FLAG: "border-flag-line bg-flag-soft text-flag",
  BLOCK: "border-block-line bg-block-soft text-block",
};

/** Plain-language names for the engine's PASS / FLAG / BLOCK verdicts. */
export const VERDICT_LABEL: Record<VerdictT, string> = { PASS: "Match", FLAG: "Check first", BLOCK: "Blocked" };

const VERDICT_ICON = { PASS: CheckCircle2, FLAG: AlertTriangle, BLOCK: ShieldX } as const;

/** Verdicts always carry an icon shape and a word, never colour alone. */
export function VerdictBadge({ verdict, large }: { verdict: VerdictT; large?: boolean }) {
  const Icon = VERDICT_ICON[verdict];
  return (
    <Badge className={cn(VERDICT_STYLE[verdict], large && "px-2 py-1 text-xs")}>
      <Icon className={large ? "h-4 w-4" : "h-3.5 w-3.5"} />
      {VERDICT_LABEL[verdict]}
    </Badge>
  );
}

const STATUS_LABEL: Record<StatusT, string> = { pass: "Pass", flag: "Check first", block: "Blocked" };

export function StatusIcon({ status, withLabel }: { status: StatusT; withLabel?: boolean }) {
  const color = status === "pass" ? "text-pass" : status === "flag" ? "text-flag" : "text-block";
  const Icon = status === "pass" ? CheckCircle2 : status === "flag" ? AlertTriangle : ShieldX;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", color)}>
      <Icon className={cn("h-4 w-4 shrink-0", status === "flag" && "text-flag-icon")} />
      <span className={withLabel ? "eyebrow" : "sr-only"}>{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Move keyboard focus to an element once React has rendered it. */
export function focusSoon(id: string, timeoutMs = 2000) {
  const started = Date.now();
  const tryFocus = () => {
    const el = document.getElementById(id);
    // Wait until the element exists, is visible and enabled (e.g. after a loading state ends).
    if (el && el.offsetParent !== null && !(el as HTMLButtonElement).disabled) {
      el.focus();
      if (document.activeElement === el) return;
    }
    if (Date.now() - started < timeoutMs) setTimeout(tryFocus, 50);
  };
  setTimeout(tryFocus, 30);
}

export const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
