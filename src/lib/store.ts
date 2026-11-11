import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Approval, ContractVersion } from "./contract";
import type { EvidenceEvent } from "./evidence";
import type { EvidenceSnapshot, Facts, AgentClaim } from "./facts";
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
 * memory does not persist between requests), otherwise in process memory.
 */
let supabase: SupabaseClient | null = null;
export function db(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  supabase ??= createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

export const storageMode = () => (db() ? "supabase" : "memory");

const g = globalThis as unknown as { __pactSessions?: Map<string, Session> };
const mem = (g.__pactSessions ??= new Map<string, Session>());

export class OutdatedSessionError extends Error {}

export async function loadSession(id: string): Promise<Session | null> {
  const client = db();
  let s: Session | null;
  if (!client) {
    s = mem.get(id) ? structuredClone(mem.get(id)!) : null;
  } else {
    const { data, error } = await client.from("pact_sessions").select("data").eq("id", id).maybeSingle();
    if (error) throw new Error(`Supabase load failed: ${error.message}`);
    s = (data?.data as Session) ?? null;
  }
  if (!s) return null;
  if ((s as { v?: number }).v !== 2) throw new OutdatedSessionError("This purchase was made with an older version of PACT.");
  if (new Date(s.expiresAt).getTime() < Date.now()) return null;
  return s;
}

export async function saveSession(s: Session): Promise<void> {
  const client = db();
  if (!client) {
    mem.set(s.id, structuredClone(s));
    return;
  }
  const { error } = await client
    .from("pact_sessions")
    .upsert({ id: s.id, data: s, updated_at: new Date().toISOString(), expires_at: s.expiresAt, schema_version: 2 });
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
}
