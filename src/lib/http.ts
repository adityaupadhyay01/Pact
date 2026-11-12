import "server-only";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { PactError } from "./errors";
import { StorageError } from "./store";
import { ConfigError } from "./env";

/** Largest JSON body PACT accepts (requests, edits and receipts are small). */
export const MAX_BODY_BYTES = 64 * 1024;

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Runs a route handler. Known errors become a safe message and a machine code;
 * anything unexpected is logged with an id and returned as a generic 500, so
 * stack traces, SQL and provider errors never reach the browser.
 */
export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof PactError) return json({ error: err.message, code: err.code ?? null }, err.status);
    if (err instanceof StorageError) return json({ error: err.message, code: "STORAGE_UNAVAILABLE" }, 503);
    if (err instanceof ConfigError) {
      console.error("[config]", err.message);
      return json({ error: "PACT isn't fully configured on this server yet. Nothing was charged.", code: "CONFIG_MISSING" }, 503);
    }
    if (err instanceof ZodError) {
      return json({ error: "Invalid input.", code: "INVALID_INPUT", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
    }
    const ref = randomUUID().slice(0, 8);
    console.error(`[api] unexpected error ${ref}:`, (err as Error)?.name, (err as Error)?.message);
    return json({ error: `Something went wrong on PACT's side (ref ${ref}). Nothing was charged.`, code: "INTERNAL" }, 500);
  }
}

/**
 * Reads a JSON request body safely:
 * - JSON only (a cross-site HTML form can't send it without a CORS preflight, which PACT doesn't allow),
 * - same-origin when the browser sends an Origin header (CSRF defence for the bearer-link sessions),
 * - at most MAX_BODY_BYTES.
 */
export async function body<T = Record<string, unknown>>(req: Request, maxBytes = MAX_BODY_BYTES): Promise<T> {
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    let ok = false;
    try {
      ok = new URL(origin).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw new PactError(403, "Requests must come from the PACT site.", "FORBIDDEN_ORIGIN");
  }
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new PactError(415, "Send JSON (Content-Type: application/json).", "UNSUPPORTED_MEDIA_TYPE");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new PactError(413, "Request too large.", "TOO_LARGE");
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new PactError(413, "Request too large.", "TOO_LARGE");
  if (!text.trim()) return {} as T;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as T;
  } catch {
    throw new PactError(400, "The request body isn't valid JSON.", "INVALID_INPUT");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session ids are random UUIDs; anything else is rejected before touching storage. */
export function sessionId(id: string): string {
  if (!UUID.test(id)) throw new PactError(404, "This purchase is no longer available. Please start again.", "NOT_FOUND");
  return id.toLowerCase();
}

/** PayPal order ids (and SIM- ids) are short and alphanumeric. Prevents odd values reaching PayPal URLs. */
export function orderId(v: unknown): string {
  const s = String(v ?? "");
  if (!/^[A-Za-z0-9-]{4,64}$/.test(s)) throw new PactError(400, "Invalid PayPal order id.", "INVALID_INPUT");
  return s;
}

/** Product ids come from Channel3 or the test store; keep them short and printable. */
export function productId(v: unknown): string {
  const s = String(v ?? "");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(s)) throw new PactError(400, "Invalid product id.", "INVALID_INPUT");
  return s;
}
