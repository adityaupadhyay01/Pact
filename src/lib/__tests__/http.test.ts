import { describe, expect, it } from "vitest";
import { body, handle, orderId, productId, sessionId } from "../http";
import { PactError } from "../errors";
import { StorageError } from "../store";

const req = (init: { body?: string; type?: string; origin?: string; host?: string }) =>
  new Request("http://localhost:3000/api/x", {
    method: "POST",
    body: init.body ?? "{}",
    headers: {
      ...(init.type !== undefined ? { "content-type": init.type } : { "content-type": "application/json" }),
      ...(init.origin ? { origin: init.origin } : {}),
      host: init.host ?? "localhost:3000",
    },
  });

describe("API input handling", () => {
  it("accepts same-origin JSON", async () => {
    expect(await body(req({ body: '{"a":1}', origin: "http://localhost:3000" }))).toEqual({ a: 1 });
  });

  it("rejects cross-site requests, non-JSON, oversized and malformed bodies", async () => {
    await expect(body(req({ origin: "https://evil.example" }))).rejects.toMatchObject({ status: 403 });
    await expect(body(req({ type: "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(body(req({ body: JSON.stringify({ x: "a".repeat(70_000) }) }))).rejects.toMatchObject({ status: 413 });
    await expect(body(req({ body: "{not json" }))).rejects.toMatchObject({ status: 400 });
    await expect(body(req({ body: "[1,2]" }))).rejects.toMatchObject({ status: 400 });
  });

  it("validates ids before they reach storage or PayPal URLs", () => {
    expect(sessionId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(() => sessionId("../../etc")).toThrow(PactError);
    expect(orderId("5O190127TN364715T")).toBe("5O190127TN364715T");
    expect(() => orderId("abc/../../v1/oauth2")).toThrow(PactError);
    expect(() => productId("x".repeat(200))).toThrow(PactError);
  });

  it("never returns raw server errors to the client", async () => {
    const res = await handle(async () => {
      throw new Error("relation pact_sessions does not exist at db.internal:5432");
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toMatch(/db\.internal|relation/);
    expect(json.code).toBe("INTERNAL");

    const storage = await handle(async () => {
      throw new StorageError("PACT couldn't reach its database.");
    });
    expect(storage.status).toBe(503);
    expect((await storage.json()).code).toBe("STORAGE_UNAVAILABLE");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
