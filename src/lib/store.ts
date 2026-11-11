import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Approval, ContractVersion } from "./contract";
import type { EvidenceEvent } from "./evidence";
import type { FactKey, ListingFacts } from "./facts";
import type { InjectionReport } from "./injection";
import type { Check, Evaluation } from "./rules";
import type { OrderSummary, PurchaseSnapshot } from "./order-verify";
import type { Engine } from "./ai";
import type { SimStore } from "./paypal";

export interface ListingResult {
  listingId: string;
  facts: ListingFacts;
  rejectedFacts: { key: FactKey; quote: string }[];
  injection: InjectionReport;
  evaluation: Evaluation;
  engine: Engine;
}

export interface Session {
  id: string;
  createdAt: string;
  requestText: string;
  parseEngine: Engine;
  contracts: ContractVersion[];
  approvals: Approval[];
  search: null | {
    contractHash: string;
    results: ListingResult[];
    recommendedId: string | null;
    unprotected: null | {
      listingId: string;
      reasoning: string[];
      claimSummary: string;
      evaluation: Evaluation;
    };
  };
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

/**
 * Sessions live in Supabase Postgres when configured (needed on Vercel, where
 * memory does not persist between requests), otherwise in process memory.
 */
let supabase: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabase ??= createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

export const storageMode = () => (db() ? "supabase" : "memory");

const g = globalThis as unknown as { __pactSessions?: Map<string, Session> };
const mem = (g.__pactSessions ??= new Map<string, Session>());

export async function loadSession(id: string): Promise<Session | null> {
  const client = db();
  if (!client) return mem.get(id) ? structuredClone(mem.get(id)!) : null;
  const { data, error } = await client.from("pact_sessions").select("data").eq("id", id).maybeSingle();
  if (error) throw new Error(`Supabase load failed: ${error.message}`);
  return (data?.data as Session) ?? null;
}

export async function saveSession(s: Session): Promise<void> {
  const client = db();
  if (!client) {
    mem.set(s.id, structuredClone(s));
    return;
  }
  const { error } = await client
    .from("pact_sessions")
    .upsert({ id: s.id, data: s, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
}
