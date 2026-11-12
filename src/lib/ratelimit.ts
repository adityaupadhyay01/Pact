import "server-only";
import { createHash } from "node:crypto";
import { PactError } from "./errors";
import { db } from "./store";

/**
 * Fixed-window rate limiting, to protect the free Gemini and Channel3 quotas on
 * a public demo.
 *
 * - Shared counters live in Supabase (`pact_hit`, an atomic upsert), so every
 *   serverless instance sees the same counts.
 * - In development and tests, process memory is used when Supabase isn't
 *   configured or fails. In production that fallback is never used: if the
 *   shared counter can't be reached, the operation is refused (fail closed),
 *   because per-instance memory counters can't enforce a limit on Vercel.
 */

const g = globalThis as unknown as { __pactHits?: Map<string, { window: number; count: number }> };
const mem = (g.__pactHits ??= new Map());

const memoryAllowed = () => process.env.NODE_ENV !== "production";

/** Thrown when the shared counter is unreachable in production. Safe to show. */
export class RateLimitUnavailable extends PactError {
  constructor() {
    super(503, "PACT can't check its usage limits right now, so live checks are paused. Try again shortly.", "RATE_LIMIT_UNAVAILABLE");
  }
}

/** In-process counter. Increment and compare happen synchronously, so concurrent calls can't both slip under the limit. */
function memoryHit(bucket: string, limit: number, window: number): boolean {
  const cur = mem.get(bucket);
  if (!cur || cur.window !== window) {
    mem.set(bucket, { window, count: 1 });
    return 1 <= limit;
  }
  cur.count++;
  return cur.count <= limit;
}

/** Returns true if the call is allowed. Throws RateLimitUnavailable when limits can't be enforced. */
export async function hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const client = db();
  if (client) {
    try {
      const { data, error } = await client.rpc("pact_hit", {
        p_bucket: bucket,
        p_window: new Date(window * 1000).toISOString(),
        p_limit: limit,
      });
      if (!error && typeof data === "boolean") return data;
      console.error("[ratelimit] shared counter failed:", error?.code ?? "unexpected response");
    } catch (err) {
      console.error("[ratelimit] shared counter failed:", (err as Error).name);
    }
    if (!memoryAllowed()) throw new RateLimitUnavailable();
    return memoryHit(bucket, limit, window);
  }
  if (!memoryAllowed() && process.env.PACT_ALLOW_MEMORY_STORAGE !== "true") throw new RateLimitUnavailable();
  return memoryHit(bucket, limit, window);
}

/** Test hook: forget all in-memory counters. */
export const resetMemoryCounters = () => mem.clear();

/**
 * A stable, non-reversible key for one visitor, so limits can't be reset by
 * starting a new session. The raw IP is never stored.
 */
export function clientKey(raw: string): string {
  const salt = process.env.EVIDENCE_SECRET ?? "pact-dev";
  return createHash("sha256").update(`${salt}:${raw}`).digest("hex").slice(0, 24);
}

export const LIMITS = {
  /** Checks a single visitor can start per 10 minutes. */
  perClient: { limit: 8, window: 600 },
  /** Test-store checks per visitor per 10 minutes (no AI or catalog calls, so a looser limit). */
  perClientTest: { limit: 120, window: 600 },
  /** Channel3 searches per month across the whole demo (free tier is 1,000 credits). */
  catalogMonthly: { limit: 800, window: 31 * 24 * 3600 },
  /** Gemini-heavy runs per minute across the whole demo. */
  aiPerMinute: { limit: 12, window: 60 },
  /** Channel3 searches one check may run (each costs a credit). */
  searchesPerSession: { limit: 5, window: 7 * 24 * 3600 },
  /** Gemini-backed steps (agent choice, verification, re-check) one check may run. */
  aiStepsPerSession: { limit: 15, window: 7 * 24 * 3600 },
  /** Per visitor across all their sessions, so a new session doesn't reset the allowance. */
  searchesPerClientHour: { limit: 20, window: 3600 },
  aiStepsPerClientHour: { limit: 60, window: 3600 },
} as const;
