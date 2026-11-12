import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Channel3 and PayPal clients against a mocked `fetch`. The responses are
 * test fixtures shaped like the documented APIs; no network is used.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const c3Product = (over: Record<string, unknown> = {}) => ({
  id: "c3_123",
  title: "Trail Runner 2 Running Shoe",
  description: "Lightweight trail running shoe.",
  brands: [{ name: "ExampleBrand" }],
  key_features: ["Waterproof upper"],
  structured_attributes: { size: ["9", "10"] },
  offers: [
    { domain: "shoes.example", price: { price: 119.0, currency: "USD" }, availability: "InStock", condition: "new" },
    { domain: "cheap.example", price: { price: 99.0, currency: "USD" }, availability: "OutOfStock", condition: "new" },
  ],
  ...over,
});

describe("Channel3 client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CHANNEL3_API_KEY", "test-key");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const load = () => import("../catalog/channel3");
  const req = { query: "running shoes", maxPrice: 120, currency: "USD", conditions: ["new" as const], limit: 10 };

  it("searches with the key in a header and normalises products", async () => {
    fetchMock.mockResolvedValue(json(200, { products: [c3Product()] }));
    const { searchChannel3 } = await load();
    const out = await searchChannel3(req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/search$/);
    expect(url).not.toMatch(/test-key/);
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "test-key" });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ query: "running shoes", filters: { price: { max_price: 120 } } });
    expect(out).toHaveLength(1);
    // The in-stock offer is chosen, even though a cheaper one is out of stock.
    expect(out[0].offer).toMatchObject({ domain: "shoes.example", price: 119, currency: "USD", availability: "InStock" });
    expect(out[0].provider).toBe("channel3");
  });

  it("returns an empty list for no results", async () => {
    fetchMock.mockResolvedValue(json(200, { products: [] }));
    expect(await (await load()).searchChannel3(req)).toEqual([]);
  });

  it("never invents missing fields: no merchant or price means the product is skipped", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        products: [
          c3Product({ id: "no-offers", offers: [] }),
          c3Product({ id: "no-domain", offers: [{ price: { price: 10, currency: "USD" }, availability: "InStock" }] }),
          c3Product({ id: "no-price", offers: [{ domain: "x.example", availability: "InStock" }] }),
          c3Product({ id: "minimal", description: null, brands: null, key_features: null, structured_attributes: null }),
        ],
      }),
    );
    const out = await (await load()).searchChannel3(req);
    expect(out.map((p) => p.id)).toEqual(["minimal"]);
    expect(out[0]).toMatchObject({ description: null, brands: [], keyFeatures: [], attributes: {} });
  });

  it.each([
    [402, "credits"],
    [429, "rate_limited"],
    [401, "auth"],
    [404, "not_found"],
    [503, "outage"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    fetchMock.mockResolvedValue(json(status, { detail: "x" }));
    await expect((await load()).searchChannel3(req)).rejects.toMatchObject({ kind });
  });

  it("maps a timeout and a malformed body separately", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await expect((await load()).searchChannel3(req)).rejects.toMatchObject({ kind: "timeout" });
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    await expect((await load()).searchChannel3(req)).rejects.toMatchObject({ kind: "malformed" });
    fetchMock.mockResolvedValue(json(200, { products: "nope" }));
    await expect((await load()).searchChannel3(req)).rejects.toMatchObject({ kind: "malformed" });
  });

  it("refreshes one product through the free detail endpoint", async () => {
    fetchMock.mockResolvedValue(json(200, c3Product({ offers: [{ domain: "shoes.example", price: { price: 109, currency: "USD" }, availability: "InStock" }] })));
    const p = await (await load()).productChannel3("c3_123", "USD");
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/products\/c3_123/);
    expect(p?.offer.price).toBe(109);
    expect(Date.parse(p!.retrievedAt)).toBeGreaterThan(Date.now() - 5000);
  });

  it("refuses to run without a key", async () => {
    vi.stubEnv("CHANNEL3_API_KEY", "");
    await expect((await load()).searchChannel3(req)).rejects.toMatchObject({ kind: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PayPal Sandbox client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const quote = { currency: "USD", itemPrice: 19.99, shipping: 0, tax: 0, fees: [], recurring: null };
  const order = (status: string, captures?: unknown[]) => ({
    id: "ORDER-1",
    status,
    purchase_units: [
      {
        reference_id: "p1",
        custom_id: "snap-hash",
        amount: { currency_code: "USD", value: "19.99", breakdown: { item_total: { value: "19.99" } } },
        ...(captures ? { payments: { captures } } : {}),
      },
    ],
  });

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PAYPAL_CLIENT_ID", "client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/v1/oauth2/token")) return json(200, { access_token: "tok", expires_in: 3600 });
      return json(500, {});
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const load = () => import("../paypal");

  it("authenticates, then creates an order with an idempotency key and the approval hash", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/v1/oauth2/token") ? json(200, { access_token: "tok", expires_in: 3600 }) : json(201, order("CREATED")),
    );
    const pp = await load();
    expect(pp.paypalMode()).toBe("sandbox");
    const o = await pp.createOrder(quote, "p1", "snap-hash", "Shoe", {});
    expect(o).toMatchObject({ id: "ORDER-1", total: "19.99", customId: "snap-hash" });
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect((tokenInit as RequestInit).headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) });
    const [, createInit] = fetchMock.mock.calls[1];
    expect((createInit as RequestInit).headers).toMatchObject({ "PayPal-Request-Id": "pact-order-snap-hash", Authorization: "Bearer tok" });
    expect(JSON.parse(String((createInit as RequestInit).body)).purchase_units[0]).toMatchObject({ custom_id: "snap-hash", amount: { value: "19.99" } });
  });

  it("returns the captured amount, and resolves an already-captured order", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/v1/oauth2/token")) return json(200, { access_token: "tok", expires_in: 3600 });
      call++;
      if (call === 1) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      return json(200, order("COMPLETED", [{ id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: "19.99" } }]));
    });
    const cap = await (await load()).captureOrder("ORDER-1", {});
    expect(cap).toEqual({ status: "COMPLETED", captureId: "CAP-1", amount: "19.99", currency: "USD" });
  });

  it("surfaces a declined card as INSTRUMENT_DECLINED", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/v1/oauth2/token")
        ? json(200, { access_token: "tok", expires_in: 3600 })
        : json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }),
    );
    await expect((await load()).captureOrder("ORDER-1", {})).rejects.toMatchObject({ issue: "INSTRUMENT_DECLINED" });
  });

  it("fails clearly on bad credentials and timeouts", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "invalid_client" }));
    await expect((await load()).getOrder("ORDER-1", {})).rejects.toMatchObject({ issue: "AUTH_FAILED" });
    vi.resetModules();
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect((await load()).getOrder("ORDER-1", {})).rejects.toMatchObject({ issue: "TIMEOUT" });
  });

  it("refuses to talk to PayPal's live API", async () => {
    vi.stubEnv("PAYPAL_API_BASE", "https://api-m.paypal.com");
    await expect((await load()).getOrder("ORDER-1", {})).rejects.toMatchObject({ issue: "NOT_SANDBOX" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never simulates payments in production without an explicit opt-in", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    const pp = await load();
    expect(pp.paypalMode()).toBe("unavailable");
    await expect(pp.createOrder(quote, "p1", "h", "x", {})).rejects.toMatchObject({ issue: "UNAVAILABLE" });
    vi.stubEnv("PAYPAL_ALLOW_SIMULATOR", "true");
    expect(pp.paypalMode()).toBe("simulated");
  });
});
