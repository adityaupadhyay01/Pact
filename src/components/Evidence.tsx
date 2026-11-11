"use client";

import { useState } from "react";
import { Download, ShieldAlert, ShieldCheck, FlaskConical } from "lucide-react";
import type { ChainVerification } from "@/lib/evidence";
import { Badge, Button, Details, Step, type StepControl, cn, shortHash, stepNumber } from "./ui";
import { post, type SessionView } from "./api";

export function Evidence({ session, control }: { session: SessionView; control: StepControl }) {
  const [tamper, setTamper] = useState<{ result: ChainVerification; target: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const events = session.events;
  const chain = session.chain;

  const download = () => {
    const pkg = {
      format: "pact-evidence/v1",
      generatedAt: new Date().toISOString(),
      sessionId: session.id,
      requestText: session.requestText,
      contracts: session.contracts,
      approvals: session.approvals,
      purchaseApproval: session.snapshot,
      paypal: session.order && {
        orderId: session.order.id,
        captureId: session.order.captureId,
        status: session.order.status,
        verification: session.order.verification,
      },
      chain: { headHash: chain.headHash, valid: chain.valid },
      // HMAC-SHA256 by the PACT server over the chain head. POST this whole file to /api/evidence/verify to check it.
      receipt: session.receipt,
      events,
    };
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pact-evidence-${session.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Edit one event in a copy (as a dishonest party might) and ask the server to verify it.
  const runTamperTest = async () => {
    setBusy(true);
    try {
      const target = Math.max(
        events.findIndex((e) => e.type === "PURCHASE_APPROVED"),
        events.findIndex((e) => e.type === "CONTRACT_APPROVED"),
        1,
      );
      const forged = structuredClone(events);
      forged[target] = {
        ...forged[target],
        summary: forged[target].summary + " (edited)",
        data: { ...(forged[target].data as object), forged: true },
      };
      const result = await post<ChainVerification>("/api/evidence/verify", {
        sessionId: session.id,
        events: forged,
        receipt: session.receipt,
      });
      setTamper({ result, target });
    } finally {
      setBusy(false);
    }
  };

  const ACTOR: Record<string, string> = { buyer: "You", pact: "PACT", agent: "Agent", paypal: "PayPal" };
  const time = (t: string) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <Step
      control={control}
      title="Evidence receipt"
      subtitle="A record of every step, so you can prove what you agreed to if anything goes wrong. It can't be edited without us noticing."
      right={
        chain.valid ? (
          <Badge className="border-pass-line bg-pass-soft text-pass">
            <ShieldCheck className="h-3.5 w-3.5" /> Untouched
          </Badge>
        ) : (
          <Badge className="border-block-line bg-block-soft text-block">
            <ShieldAlert className="h-3.5 w-3.5" /> Edited
          </Badge>
        )
      }
    >
      <div className="grid gap-8 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        {/* Timeline */}
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Every step of this purchase, in order</caption>
          <thead>
            <tr className="border-b border-ink">
              <th scope="col" className="eyebrow w-24 py-2 pr-4 text-faint">Time</th>
              <th scope="col" className="eyebrow hidden w-20 py-2 pr-4 text-faint sm:table-cell">By</th>
              <th scope="col" className="eyebrow py-2 text-faint">What happened</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.seq} className="border-b border-line align-top">
                <td className="num whitespace-nowrap py-2.5 pr-4 font-mono text-xs text-muted">{time(e.timestamp)}</td>
                <td className="hidden py-2.5 pr-4 text-muted sm:table-cell">{ACTOR[e.actor] ?? e.actor}</td>
                <td className="py-2.5 text-ink-2">{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Integrity */}
        <aside aria-labelledby="integrity-title" className="lg:border-l lg:border-line lg:pl-6">
          <h3 id="integrity-title" className="eyebrow text-muted">
            Integrity
          </h3>
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="text-muted">Status</dt>
              <dd className={`mt-0.5 flex items-center gap-1.5 font-medium ${chain.valid ? "text-pass" : "text-block"}`}>
                {chain.valid ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
                {chain.valid ? "Every step verifies" : `Broken at step ${chain.brokenAt}`}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Steps recorded</dt>
              <dd className="num mt-0.5 font-mono text-ink">{events.length}</dd>
            </div>
            <div>
              <dt className="text-muted">Server signature</dt>
              <dd className="num mt-0.5 font-mono text-ink">{shortHash(session.receipt.signature)}</dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-col gap-2">
            <Button variant="secondary" onClick={download}>
              <Download className="h-4 w-4" /> Download receipt
            </Button>
            <Button variant="secondary" onClick={runTamperTest} loading={busy} disabled={events.length < 2}>
              <FlaskConical className="h-4 w-4" /> Try editing it
            </Button>
          </div>

          {tamper && (
            <div
              role="status"
              className={cn(
                "mt-4 border-l-4 px-3 py-2.5 text-sm",
                tamper.result.valid ? "border-pass bg-pass-soft" : "border-block bg-block-soft",
              )}
            >
              <p className="font-medium text-ink">We changed one line in a copy of your receipt and checked it again.</p>
              <p className={`mt-1 ${tamper.result.valid ? "text-pass" : "text-block"}`}>
                {tamper.result.valid ? "The change wasn't detected (this shouldn't happen)." : "The change was caught: the receipt no longer checks out."}
              </p>
              <p className="mt-1 text-xs text-muted">Your real receipt wasn&apos;t touched.</p>
            </div>
          )}
        </aside>
      </div>

      <div className="border-t border-line px-5 py-4 sm:px-6">
        <Details summary="Show technical details">
          <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted">
            Each step stores a SHA-256 fingerprint that includes the previous step&apos;s fingerprint, so changing, removing
            or reordering any step breaks every fingerprint after it. The PACT server also signs the latest fingerprint
            with a secret key (HMAC), so even someone who recomputes every fingerprint can&apos;t produce a receipt that
            checks out.
            {session.receipt.key === "ephemeral" && " This server uses a temporary demo key: set EVIDENCE_SECRET to keep receipts verifiable across restarts."}
          </p>
          <ol className="divide-y divide-line border-y border-line">
            {events.map((e) => (
              <li key={e.seq} className="num py-2 font-mono text-[11px] leading-relaxed text-muted">
                <span className="font-medium text-ink-2">
                  {stepNumber(e.seq)} {e.type}
                </span>{" "}
                · {e.actor} · hash {shortHash(e.hash)} · prev {shortHash(e.prevHash)}
                {e.sources.slice(0, 2).map((src, i) => (
                  <span key={i} className="block truncate">
                    {src.kind}: {src.ref}
                  </span>
                ))}
                {e.sources.length > 2 && <span className="block">+{e.sources.length - 2} more sources</span>}
              </li>
            ))}
          </ol>
        </Details>
      </div>
    </Step>
  );
}
