import "server-only";
import { db } from "./store";

/**
 * Fixed-window rate limiting, to protect the free Gemini and Channel3 quotas on
 * a public demo. Uses Supabase (shared across serverless instances) when
 * configured, otherwise process memory.
 */

const g = globalThis as unknown as { __pactHits?: Map<string, { window: number; count: number }> };
const mem = (g.__pactHits ??= new Map());

/** Returns true if the call is allowed. */
export async function hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const client = db();
  if (client) {
    const { data, error } = await client.rpc("pact_hit", {
      p_bucket: bucket,
      p_window: new Date(window * 1000).toISOString(),
      p_limit: limit,
    });
    if (!error) return Boolean(data);
    console.warn("[ratelimit] Supabase unavailable, using memory:", error.message);
  }
  const key = `${bucket}`;
  const cur = mem.get(key);
  if (!cur || cur.window !== window) {
    mem.set(key, { window, count: 1 });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count++;
  return true;
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
} as const;
