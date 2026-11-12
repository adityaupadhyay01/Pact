import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Approval, ContractVersion } from "./contract";
import type { EvidenceEvent } from "./evidence";
import type { EvidenceSnapshot, Fact, Facts, AgentClaim } from "./facts";
import type { InjectionReport } from "./injection";
import type { Check, Evaluation } from "./rules";
import type { OrderSummary, PurchaseSnapshot } from "./order-verify";
import type { SimStore } from "./paypal";
import type { ProductRecord } from "./catalog/types";
import type { SellerAttack } from "./seller-mode";

export type Mode = "live" | "test";
export type ServiceName = "ai" | "catalog" | "payments";

/** What actually ran for each external service in this session. "live" only after a real call succeeded. */
export interface ServiceStatus {
  state: "live" | "test" | "simulated" | "unavailable" | "error";
  detail: string;
  at: string;
}

/** One product as PACT verified it. */
export interface Verified {
  productId: string;
  record: ProductRecord;
  evidence: EvidenceSnapshot;
  facts: Facts;
  /** Requirements where the catalog field and the listing text disagree. */
  conflicts: Record<string, Fact[]>;
  rejected: { constraintId: string; quote: string }[];
  injection: InjectionReport;
  evaluation: Evaluation;
  /** Who read the listing: Gemini, the test-store reader, or catalog fields only. */
  reader: "gemini" | "test" | "catalog_fields";
  searchedPrice: number;
}

export interface Session {
  v: 2;
  id: string;
  createdAt: string;
  expiresAt: string;
  mode: Mode;
  sellerAttack: SellerAttack | null;
  requestText: string;
  intent: { engine: "gemini" | "test"; dropped: { what: string; reason: string }[]; notes: string[] };
  contracts: ContractVersion[];
  approvals: Approval[];
  discovery: null | {
    contractHash: string;
    provider: ProductRecord["provider"];
    query: string;
    retrievedAt: string;
    candidates: ProductRecord[];
    /** Price at search time per product id, to detect a price change before approval. */
    searchedPrices: Record<string, number>;
  };
  agent: null | {
    contractHash: string;
    engine: "gemini" | "test";
    chosenId: string;
    reasons: string[];
    claims: AgentClaim[];
    summary: string;
  };
  verification: null | {
    contractHash: string;
    subject: Verified;
    alternatives: Verified[];
    recommendedId: string | null;
    /** Alternatives PACT couldn't check (e.g. AI rate limit). */
    unchecked: string[];
  };
  /** Hashed visitor key for per-visitor limits (never the raw IP). */
  clientKey?: string;
  services: Partial<Record<ServiceName, ServiceStatus>>;
  snapshot: PurchaseSnapshot | null;
  order: null | {
    id: string;
    status: string;
    captureId: string | null;
    verification: { ok: boolean; checks: Check[] } | null;
    paypal: OrderSummary | null;
  };
  events: EvidenceEvent[];
  /** Simulated PayPal orders (simulator mode only), kept with the session so serverless instances share them. */
  simOrders?: SimStore;
}

/** How long a session (and the buyer's request text) is kept. */
export const SESSION_TTL_DAYS = 7;

/**
 * Sessions live in Supabase Postgres when configured (needed on Vercel, where
 * memory does not persist between requests). Process memory is used only in
 * development, or in production with PACT_ALLOW_MEMORY_STORAGE=true; otherwise
 * PACT refuses to run rather than pretend sessions are saved.
 */
let supabase: SupabaseClient | null = null;
export function db(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabase ??= createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

export const storageMode = (): "supabase" | "memory" | "unavailable" =>
  db()
    ? "supabase"
    : process.env.NODE_ENV !== "production" || process.env.PACT_ALLOW_MEMORY_STORAGE === "true"
      ? "memory"
      : "unavailable";

const g = globalThis as unknown as { __pactSessions?: Map<string, Session>; __pactCleanupAt?: number };
const mem = (g.__pactSessions ??= new Map<string, Session>());

export class OutdatedSessionError extends Error {}

/** Storage is missing or failed. The message is safe to show; details are only logged. */
export class StorageError extends Error {}

function storageFailure(what: string, detail: string): StorageError {
  console.error(`[store] ${what} failed:`, detail);
  return new StorageError("PACT couldn't reach its database. Nothing was saved. Try again in a moment.");
}

function requireStorage() {
  if (storageMode() === "unavailable") {
    throw new StorageError("PACT's database isn't configured on this server, so it can't keep your session.");
  }
}

export async function loadSession(id: string): Promise<Session | null> {
  requireStorage();
  const client = db();
  let s: Session | null;
  if (!client) {
    s = mem.get(id) ? structuredClone(mem.get(id)!) : null;
  } else {
    const { data, error } = await client.from("pact_sessions").select("data").eq("id", id).maybeSingle();
    if (error) throw storageFailure("load", error.message);
    s = (data?.data as Session) ?? null;
  }
  if (!s) return null;
  if ((s as { v?: number }).v !== 2) throw new OutdatedSessionError("This purchase was made with an older version of PACT.");
  // Expired sessions are treated as gone, even before cleanup deletes them.
  if (new Date(s.expiresAt).getTime() < Date.now()) return null;
  return s;
}

export async function saveSession(s: Session): Promise<void> {
  requireStorage();
  const client = db();
  if (!client) {
    mem.set(s.id, structuredClone(s));
    return;
  }
  const { error } = await client
    .from("pact_sessions")
    .upsert({ id: s.id, data: s, updated_at: new Date().toISOString(), expires_at: s.expiresAt, schema_version: 2 });
  if (error) throw storageFailure("save", error.message);
}

/**
 * Deletes sessions past their expiry (the 7-day retention the UI promises) and
 * old rate-limit counters. Runs at most once an hour per server instance, from
 * normal traffic; a failure is logged and never blocks the request.
 */
export async function cleanupExpired(now = Date.now()): Promise<number> {
  if (g.__pactCleanupAt && now - g.__pactCleanupAt < 3_600_000) return 0;
  g.__pactCleanupAt = now;
  const client = db();
  if (!client) {
    let n = 0;
    for (const [id, s] of mem) {
      if (new Date(s.expiresAt).getTime() < now) {
        mem.delete(id);
        n++;
      }
    }
    return n;
  }
  try {
    const cutoff = new Date(now).toISOString();
    const { data, error } = await client.from("pact_sessions").delete().lt("expires_at", cutoff).select("id");
    if (error) throw new Error(error.message);
    const usageCutoff = new Date(now - 40 * 86_400_000).toISOString();
    await client.from("pact_usage").delete().lt("window_start", usageCutoff);
    return data?.length ?? 0;
  } catch (err) {
    console.warn("[store] cleanup failed:", (err as Error).message);
    return 0;
  }
}

/** Test hook: forget the last cleanup time. */
export const resetCleanupTimer = () => {
  g.__pactCleanupAt = undefined;
};
