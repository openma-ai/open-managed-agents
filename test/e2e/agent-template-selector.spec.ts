import { expect, test, type Page } from "@playwright/test";

async function openTemplates(page: Page) {
  await page.addInitScript(() => localStorage.setItem("oma-locale", "en"));
  await page.route("**/auth/get-session**", (route) => route.fulfill({
    json: {
      session: {
        id: "template-test-session", token: "browser-only-test-token", userId: "template-test-user",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      user: {
        id: "template-test-user", name: "Template test", email: "templates@openma.test",
        emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    },
  }));
  await page.route("**/v1/**", (route) => route.fulfill({ json: {
    data: new URL(route.request().url()).pathname === "/v1/oma/me/tenants"
      ? [{ id: "tenant_templates", name: "Templates", role: "owner" }]
      : [],
    next_page: null, next_cursor: null,
  } }));
  await page.goto("/agents");
  await page.getByRole("button", { name: /New agent$/ }).first().click();
  await expect(page.getByRole("textbox", { name: "Search templates" })).toBeVisible();
}

for (const width of [1280, 375, 320]) {
  test(`template cards contain their content at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openTemplates(page);
    const dialog = page.getByRole("dialog");
    const first = dialog.getByRole("button", { name: /^Blank agent config/ });
    const grid = first.locator("..");
    const cards = grid.getByRole("button");
    await expect(cards).toHaveCount(10);
    const metrics = await cards.evaluateAll((elements) => elements.map((card) => {
      const rect = card.getBoundingClientRect();
      const children = Array.from(card.querySelectorAll("span, div, svg"));
      return {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        height: rect.height,
        horizontalOverflow: card.scrollWidth > card.clientWidth,
        contentContained: children.every((child) => {
          const box = child.getBoundingClientRect();
          return box.left >= rect.left && box.right <= rect.right &&
            box.top >= rect.top && box.bottom <= rect.bottom;
        }),
      };
    }));
    await page.screenshot({ path: testInfo.outputPath("template-selector.png") });
    for (const card of metrics) {
      expect.soft(card.contentContained).toBe(true);
      expect.soft(card.horizontalOverflow).toBe(false);
      expect.soft(card.height).toBeGreaterThan(60);
      expect.soft(card.left).toBeGreaterThanOrEqual(0);
      expect.soft(card.right).toBeLessThanOrEqual(width);
    }
    if (width < 640) {
      expect(metrics[1].left).toBe(metrics[0].left);
      expect(metrics[1].top).toBeGreaterThanOrEqual(metrics[0].bottom);
    } else {
      expect(metrics[1].top).toBe(metrics[0].top);
      expect(metrics[1].left).toBeGreaterThan(metrics[0].right);
      expect(metrics[2].top).toBeGreaterThanOrEqual(metrics[0].bottom);
    }
    const search = page.getByRole("textbox", { name: "Search templates" });
    await search.fill("github");
    const incident = dialog.getByRole("button", { name: /^Incident commander/ });
    await expect(incident.locator("..").getByRole("button")).toHaveCount(1);
    await expect(incident.getByRole("img", { name: "GitHub", exact: true })).toHaveAttribute("title", "GitHub");
    await expect(incident.locator("img")).toHaveCount(0);
    await search.press("Tab");
    await expect(incident).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("template-search-focused.png") });
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: "JSON", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: /Templates/ }).click();
    await search.fill("not-a-template");
    await expect(dialog.getByText("No templates match your search.")).toBeVisible();
  });
}
