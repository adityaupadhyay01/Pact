import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end tests of the six-step flow, written the way a first-time visitor
 * uses it. They run against the PayPal simulator, so they are skipped when
 * real sandbox credentials are configured.
 */

async function startAndCheck(page: Page) {
  await page.goto("/");
  const config = await (await page.request.get("/api/config")).json();
  test.skip(config.paypal !== "simulated", "E2E flow uses the PayPal simulator");

  // Step 0: the one obvious action on the homepage.
  await page.getByRole("button", { name: "Check my purchase" }).click();
  // Step 1: confirm the requirements. This also runs the agent and PACT's check.
  await page.getByRole("button", { name: "Looks right, run the check" }).click();
  await expect(page.locator("#decision-primary")).toBeVisible();
}

test("the homepage explains the product and has one obvious action", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("AI shopping agent buys exactly what you asked for");
  await expect(page.getByLabel("What do you want your AI shopping agent to buy?")).not.toHaveValue("");
  await expect(page.getByRole("button", { name: "Check my purchase" })).toBeVisible();
  await expect(page.getByText("Nothing is bought or charged")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What happens after you click" })).toBeVisible();
  // The first screen already shows the input and the button without scrolling.
  const box = await page.getByRole("button", { name: "Check my purchase" }).boundingBox();
  expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height);
});

test("a regular agent is fooled, PACT blocks it and pays only for the laptop that follows the rules", async ({ page }) => {
  await startAndCheck(page);

  // Step 2 and 3: the agent's pick, and the evidence against it.
  await expect(page.getByRole("heading", { name: /Product discovery/ })).toBeVisible();
  await expect(page.getByText("The agent picked")).toBeVisible();
  await expect(page.getByText("Contains hidden text aimed at AI agents")).toBeVisible();
  // Step 4: the verdict, in plain words, with a safer alternative.
  await expect(page.getByText("Blocked: don't buy this one.")).toBeVisible();
  await expect(page.getByText("$1,330.19").first()).toBeVisible();
  await expect(page.getByText("PACT's closest match")).toBeVisible();

  await page.locator("#decision-primary").click();
  await page.getByRole("button", { name: /Confirm \$872\.24 and continue/ }).click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();

  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
  await expect(page.getByText("Paid with PayPal").first()).toBeVisible();
  await expect(page.getByText("Untouched")).toBeVisible();

  // The receipt opens on its own once the payment has an outcome.
  await expect(page.getByRole("button", { name: /Evidence receipt/ })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Try editing it" }).click();
  await expect(page.getByText("The change was caught")).toBeVisible();
});

test("seller bait-and-switch is stopped before any money moves", async ({ page }) => {
  await startAndCheck(page);

  // Orbit Pro 14 follows every rule on the listing, but its checkout asks PayPal for $15 more.
  await page.getByText(/Compare all 12 listings/).click();
  await page.getByRole("button", { name: /Orbit Pro 14/ }).click();
  await page.locator("#listing-L-106").getByRole("button", { name: "Buy this one" }).click();
  await page.getByRole("button", { name: /Confirm .* and continue/ }).click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();

  await expect(page.getByText("Payment stopped. No money moved.")).toBeVisible();
  await expect(page.getByText(/asked PayPal for \$897\.89/)).toBeVisible();
  await expect(page.getByText("Payment complete", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Payment stopped. Nothing was charged")).toBeVisible();
});

test("changing a requirement asks the user to confirm again", async ({ page }) => {
  await startAndCheck(page);

  // Confirmed requirements collapse to a one-line summary and can be reopened.
  const toggle = page.getByRole("button", { name: /Your requirements/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.getByRole("button", { name: "Change requirements" }).click();
  await page.getByLabel("Max total price").fill("950");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("button", { name: "Looks right, run the check" })).toBeVisible();
  await expect(page.getByText("Total price up to $950.00")).toBeVisible();
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

test("a listing that needs your OK can only be bought after you confirm each issue", async ({ page }) => {
  await startAndCheck(page);
  // Nimbus 14 adds a platform fee at checkout.
  await page.getByText(/Compare all 12 listings/).click();
  await page.getByRole("button", { name: /Nimbus 14/ }).click();
  await page.locator("#listing-L-104").getByRole("button", { name: "Buy this one" }).click();
  const confirm = page.getByRole("button", { name: /Confirm .* and continue/ });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: /Extra fees/ }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.getByRole("button", { name: "Pay with PayPal" }).click();
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
});

test("every example request ends in a stated verdict and a next action", async ({ page }) => {
  await page.goto("/");
  const config = await (await page.request.get("/api/config")).json();
  test.skip(config.paypal !== "simulated", "E2E flow uses the PayPal simulator");
  await page.getByRole("button", { name: "Refurbished is fine" }).click();
  await page.getByRole("button", { name: "Check my purchase" }).click();
  await page.getByRole("button", { name: "Looks right, run the check" }).click();
  await expect(page.locator("#decision-primary")).toBeVisible();
  await expect(page.getByRole("group", { name: "PACT's verdict" })).toContainText(/Match|Check first|Blocked/);
});
