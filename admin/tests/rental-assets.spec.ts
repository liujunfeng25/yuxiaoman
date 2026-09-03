import { expect, test, type Locator } from "@playwright/test";

async function expectImageLoaded(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
}

test("汽车租赁车标和车型封面在后台正常加载", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "汽车租赁" }).click();

  await expectImageLoaded(page.locator(".used-car-brand-logo img").first());
  await expectImageLoaded(page.locator(".used-car-cover img").first());
});
