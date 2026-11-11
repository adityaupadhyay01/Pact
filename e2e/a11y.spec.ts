import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Automated WCAG 2.2 AA scan. Fails on any serious or critical violation. */
async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    // The Next.js dev indicator is not part of the app.
    .exclude("nextjs-portal")
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n  ")}`);
  expect(report, report.join("\n")).toEqual([]);
}

test("landing page has no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await scan(page);
});

test("full workflow has no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Watch a quick demo" }).click();
  await expect(page.locator("#decision-primary")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Show all" }).click();
  // Scan the layout from the top, not from wherever the demo scrolled to (the sticky bar would overlap content).
  await page.evaluate(() => window.scrollTo(0, 0));
  await scan(page);
});

test("primary flow works with the keyboard only", async ({ page }) => {
  const config = await (await page.request.get("/api/config")).json();
  test.skip(config.paypal !== "simulated", "Uses the PayPal simulator");
  await page.goto("/");

  const focusedText = () =>
    page.evaluate(() =>
      document.activeElement === document.body ? "" : (document.activeElement?.textContent?.trim() ?? ""),
    );

  /** Tabs to the named control (it may already be focused), presses Enter, and returns how many Tabs it took. */
  const press = async (name: RegExp | string, settleMs = 5000) => {
    const matches = (t: string) => (typeof name === "string" ? t.includes(name) : name.test(t));
    // First give the app up to a few seconds to move focus by itself (the server call may be slow on a cold start).
    for (let waited = 0; waited < settleMs; waited += 100) {
      if (matches(await focusedText())) {
        await page.keyboard.press("Enter");
        return 0;
      }
      await page.waitForTimeout(100);
    }
    for (let tabs = 1; tabs <= 60; tabs++) {
      await page.keyboard.press("Tab");
      if (matches(await focusedText())) {
        await page.keyboard.press("Enter");
        return tabs;
      }
    }
    throw new Error(`Could not reach "${name}" with Tab`);
  };

  await page.getByRole("radio", { name: /Test store/ }).check();
  await page
    .getByLabel("What do you want to buy?")
    .fill("Find me a new laptop with 16GB RAM, 1TB SSD and a two-year warranty. Maximum price $900.");
  // From the text box, the primary action is a few Tabs away (the example chips and Seller Mode come first).
  await press("Check my purchase", 0);
  // After each action, focus moves straight to the next control: no tabbing needed.
  expect(await press("Looks right, run the check")).toBe(0);
  await expect(page.locator("#decision-primary")).toBeVisible();
  expect(await press("Buy this one instead")).toBe(0);
  expect(await press(/^Confirm .* and continue$/)).toBe(0);
  expect(await press("Pay with PayPal")).toBe(0);
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
  await expect(page.locator("#payment-result")).toBeFocused();
});
