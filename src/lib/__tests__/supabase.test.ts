import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Supabase persistence and the shared rate limiter, against an in-memory fake
 * of the supabase-js client (the real database is not used here).
 */

const fake = vi.hoisted(() => {
  const tables: Record<string, Map<string, Record<string, unknown>>> = { pact_sessions: new Map(), pact_usage: new Map() };
  const fail = { load: false, save: false, rpc: false, rpcThrows: false };
  const counters = new Map<string, number>();
  const client = {
    from(table: string) {
      const t = tables[table];
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => (fail.load ? { data: null, error: { message: "connection refused" } } : { data: t.get(id) ?? null, error: null }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          if (fail.save) return { error: { message: "connection refused" } };
          t.set(String(row.id), row);
          return { error: null };
        },
        delete: () => ({
          lt: (col: string, value: string) => {
            const doDelete = () => {
              const gone: { id: string }[] = [];
              for (const [k, row] of t) {
                if (String(row[col]) < value) {
                  t.delete(k);
                  gone.push({ id: k });
                }
              }
              return gone;
            };
            return {
              select: async () => ({ data: doDelete(), error: null }),
              then: (res: (v: unknown) => void) => res({ data: doDelete(), error: null }),
            };
          },
        }),
      };
    },
    rpc: async (_fn: string, args: { p_bucket: string; p_window: string; p_limit: number }) => {
      if (fail.rpcThrows) throw new TypeError("fetch failed");
      if (fail.rpc) return { data: null, error: { code: "PGRST202", message: "function not found" } };
      const key = `${args.p_bucket}|${args.p_window}`;
      const n = (counters.get(key) ?? 0) + 1; // atomic in the real database (insert … on conflict … returning)
      counters.set(key, n);
      return { data: n <= args.p_limit, error: null };
    },
  };
  return { tables, fail, counters, client };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake.client }));

import { cleanupExpired, loadSession, resetCleanupTimer, saveSession, StorageError, storageMode, type Session } from "../store";
import { hit, resetMemoryCounters } from "../ratelimit";

const session = (id: string, expiresAt: string) =>
  ({ v: 2, id, createdAt: new Date().toISOString(), expiresAt, events: [] }) as unknown as Session;

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-fixture");
  Object.assign(fake.fail, { load: false, save: false, rpc: false, rpcThrows: false });
  fake.tables.pact_sessions.clear();
  fake.counters.clear();
  resetMemoryCounters();
});
afterEach(() => vi.unstubAllEnvs());

describe("Supabase persistence", () => {
  it("saves and loads a session (survives across server instances)", async () => {
    expect(storageMode()).toBe("supabase");
    const s = session("a", new Date(Date.now() + 86_400_000).toISOString());
    await saveSession(s);
    const row = fake.tables.pact_sessions.get("a")!;
    expect(row).toMatchObject({ id: "a", schema_version: 2, expires_at: s.expiresAt });
    expect(await loadSession("a")).toMatchObject({ id: "a" });
  });

  it("a database outage is a StorageError with a safe message, never a claimed save", async () => {
    fake.fail.save = true;
    const err = await saveSession(session("b", new Date(Date.now() + 1000).toISOString())).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).not.toMatch(/connection refused/);
    fake.fail.load = true;
    await expect(loadSession("b")).rejects.toBeInstanceOf(StorageError);
  });

  it("expired rows are unreadable and deleted by cleanup; active rows stay", async () => {
    const now = Date.now();
    await saveSession(session("old", new Date(now - 1).toISOString()));
    await saveSession(session("new", new Date(now + 60_000).toISOString()));
    expect(await loadSession("old")).toBeNull();
    resetCleanupTimer();
    expect(await cleanupExpired(now)).toBe(1);
    expect(fake.tables.pact_sessions.has("old")).toBe(false);
    expect(fake.tables.pact_sessions.has("new")).toBe(true);
  });
});

describe("shared rate limiter", () => {
  it("counts in the database across instances and enforces the limit", async () => {
    const results = await Promise.all(Array.from({ length: 7 }, () => hit("t:shared", 3, 60)));
    expect(results.filter(Boolean)).toHaveLength(3);
    resetMemoryCounters(); // a "different instance": memory is empty, the database count still applies
    expect(await hit("t:shared", 3, 60)).toBe(false);
  });

  it("RPC failure in production fails closed, without leaking the database error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fake.fail.rpc = true;
    const err = await hit("t:prod", 3, 60).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
    expect(err.message).not.toMatch(/PGRST|function not found/);
    fake.fail.rpc = false;
    fake.fail.rpcThrows = true;
    await expect(hit("t:prod", 3, 60)).rejects.toMatchObject({ code: "RATE_LIMIT_UNAVAILABLE" });
  });

  it("RPC failure in development falls back to a local counter", async () => {
    vi.stubEnv("NODE_ENV", "development");
    fake.fail.rpc = true;
    expect(await hit("t:dev", 1, 60)).toBe(true);
    expect(await hit("t:dev", 1, 60)).toBe(false);
  });
});
