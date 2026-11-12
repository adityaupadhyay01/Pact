import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end tests of the six-step flow, written the way a first-time visitor
 * uses it. They use the test store (fictional laptops, no AI) and the PayPal
 * simulator, so they are skipped when real sandbox credentials are configured.
 */

const REQUEST = "Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.";

async function openTestStore(page: Page) {
  await page.goto("/");
  const config = await (await page.request.get("/api/config")).json();
  test.skip(config.paypal !== "simulated", "E2E flow uses the PayPal simulator");
  await page.getByRole("radio", { name: /Test store/ }).check();
}

async function startAndCheck(page: Page, text = REQUEST) {
  await openTestStore(page);
  await page.getByLabel("What do you want to buy?").fill(text);
  await page.getByRole("button", { name: "Check my purchase" }).click();
  // Confirming the requirements runs the search, the agent's pick and PACT's check.
  await page.getByRole("button", { name: "Looks right, run the check" }).click();
  await expect(page.locator("#decision-primary")).toBeVisible({ timeout: 20_000 });
}

test("the homepage explains the product and has one obvious action", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("AI finds it, PACT checks it");
  await expect(page.getByLabel("What do you want to buy?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check my purchase" })).toBeVisible();
  await expect(page.getByText("Nothing is bought or charged")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What happens after you click" })).toBeVisible();
  await expect(page.getByText(/Shipping, tax and the merchant's own checkout total are not verified/)).toBeVisible();
});

test("real-product mode refuses to run without AI instead of guessing", async ({ page }) => {
  const config = await (await page.request.get("/api/config")).json();
  test.skip(config.ai && config.catalog, "Only meaningful when Gemini or Channel3 isn't configured");
  await page.goto("/");
  // Wait for the server status to load (the page is hydrated and knows what is configured).
  await expect(page.getByText(/catalog (Channel3|not configured)/)).toBeVisible();
  await page.getByRole("radio", { name: /Real products/ }).check();
  await expect(page.getByText(/Real products are unavailable/)).toBeVisible();
  await page.getByLabel("What do you want to buy?").fill("Dark chocolate, 70% cocoa, under $10");
  await expect(page.getByRole("button", { name: "Check my purchase" })).toBeDisabled();

  const api = await page.request.post("/api/session", { data: { text: "Dark chocolate under $10", mode: "live" } });
  expect(api.status()).toBe(503);
  expect((await api.json()).code).toBe("AI_UNAVAILABLE");
});

test("a hijacked agent is caught, and PACT pays only for a product that passes every check", async ({ page }) => {
  await startAndCheck(page);

  await expect(page.getByText("TEST ·")).toBeVisible();
  // Step 2 and 3: the agent's pick, and the evidence against it.
  await expect(page.getByText("The Shopping Agent picked")).toBeVisible();
  await expect(page.getByText("Contains hidden text aimed at AI agents")).toBeVisible();
  // Step 4: the verdict, in plain words, with a safer alternative.
  await expect(page.getByText("Blocked: don't buy this one.")).toBeVisible();
  await expect(page.getByText("$1,249.00").first()).toBeVisible();
  await expect(page.getByText("PACT's closest match")).toBeVisible();

  await page.locator("#decision-primary").click();
  await page.getByRole("button", { name: /Confirm \$769\.00 and continue/ }).click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();

  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
  await expect(page.getByText("Paid with PayPal Sandbox").first()).toBeVisible();
  await expect(page.getByText("Untouched")).toBeVisible();
  await expect(page.getByText(/TEST receipt/)).toBeVisible();

  // The receipt opens on its own once the payment has an outcome.
  await expect(page.getByRole("button", { name: /Evidence receipt/ })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Try editing it" }).click();
  await expect(page.getByText("The change was caught")).toBeVisible();
});

test("a seller's checkout that asks PayPal for more is stopped before any money moves", async ({ page }) => {
  await startAndCheck(page);

  // Orbit Pro 14 passes every check on the listing, but its checkout asks PayPal for $15 more.
  await page.getByText(/Compare all 12 products/).click();
  await page.getByRole("button", { name: /Orbit Pro 14/ }).click();
  await page.locator("#listing-L-106").getByRole("button", { name: "Buy this one" }).click();
  await page.getByRole("button", { name: /Confirm \$829\.00 and continue/ }).click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();

  await expect(page.getByText("Payment stopped. No money moved.")).toBeVisible();
  await expect(page.getByText(/asked PayPal for \$844\.00/)).toBeVisible();
  await expect(page.getByText("Payment complete", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Payment stopped. Nothing was charged")).toBeVisible();
});

test("Seller Mode alters the honest pick and PACT blocks it", async ({ page }) => {
  await openTestStore(page);
  await page.getByLabel("What do you want to buy?").fill(REQUEST);
  await page.getByText("Seller Mode: security test for judges").click();
  await page.getByRole("radio", { name: /Fine print contradicts the headline/ }).check();
  await page.getByRole("button", { name: "Check my purchase" }).click();
  await page.getByRole("button", { name: "Looks right, run the check" }).click();
  await expect(page.locator("#decision-primary")).toBeVisible({ timeout: 20_000 });

  await expect(page.getByText(/Seller Mode: Fine print contradicts the headline/)).toBeVisible();
  await expect(page.getByText("Blocked: don't buy this one.")).toBeVisible();
  await expect(page.getByText("TEST: altered by Seller Mode").first()).toBeVisible();
});

test("changing a requirement asks the user to confirm again", async ({ page }) => {
  await startAndCheck(page);

  // Confirmed requirements collapse to a one-line summary and can be reopened.
  const toggle = page.getByRole("button", { name: /Your requirements/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.getByRole("button", { name: "Change requirements" }).click();
  await page.getByLabel("Max item price").fill("950");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("button", { name: "Looks right, run the check" })).toBeVisible();
  await expect(page.getByText("Item price up to $950.00")).toBeVisible();
});

test("a request without a budget asks for one instead of guessing", async ({ page }) => {
  await openTestStore(page);
  await page.getByLabel("What do you want to buy?").fill("A new laptop with 16GB RAM and 1TB SSD");
  await page.getByRole("button", { name: "Check my purchase" }).click();
  await expect(page.getByText(/You didn't mention a budget/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Looks right, run the check" })).toBeDisabled();
  await page.getByLabel("Maximum item price").fill("900");
  await page.getByRole("button", { name: "Set budget" }).click();
  await expect(page.getByRole("button", { name: "Looks right, run the check" })).toBeEnabled();
});

test("a paid purchase survives a page refresh", async ({ page }) => {
  await startAndCheck(page);
  await page.locator("#decision-primary").click();
  await page.getByRole("button", { name: /Confirm .* and continue/ }).click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?session=/);

  await page.reload();
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Product discovery/ })).toBeVisible();
});

test("an unknown session link shows a clear message", async ({ page }) => {
  await page.goto("/?session=00000000-0000-0000-0000-000000000000");
  await expect(page.getByRole("alert").filter({ hasText: "no longer available" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check my purchase" })).toBeVisible();
});

test("a product that needs your OK can only be bought after you confirm each issue", async ({ page }) => {
  await startAndCheck(page);
  // Lumen 14 doesn't state a two-year warranty.
  await page.getByText(/Compare all 12 products/).click();
  await page.getByRole("button", { name: /Lumen 14/ }).click();
  await page.locator("#listing-L-107").getByRole("button", { name: "Buy this one" }).click();
  const confirm = page.getByRole("button", { name: /Confirm .* and continue/ });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: /Warranty/ }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
});

test("declined card and closing PayPal are reachable in the UI and charge nothing", async ({ page }) => {
  await startAndCheck(page);
  await page.locator("#decision-primary").click();
  await page.getByRole("button", { name: /Confirm .* and continue/ }).click();
  await expect(page.getByText(/SIMULATED PayPal/)).toBeVisible();

  await page.getByRole("button", { name: "Simulate a declined card" }).click();
  await expect(page.getByRole("status").filter({ hasText: /PayPal declined that payment method/ })).toBeVisible();

  await page.getByRole("button", { name: "Simulate closing PayPal" }).click();
  await expect(page.getByRole("status").filter({ hasText: /You closed PayPal before paying/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
});

test("mobile: no sideways scrolling, and the main actions stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openTestStore(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByLabel("What do you want to buy?").fill(REQUEST);
  await page.getByRole("button", { name: "Check my purchase" }).click();
  await page.getByRole("button", { name: "Looks right, run the check" }).click();
  await expect(page.locator("#decision-primary")).toBeVisible({ timeout: 20_000 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.locator("#decision-primary").click();
  await expect(page.getByRole("button", { name: /Confirm .* and continue/ })).toBeVisible();
});

test("security headers are set", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res?.headers()["x-frame-options"]).toBe("DENY");
});
