import { expect, test, type Page } from "@playwright/test";

const longName = "Production deployment credential with a deliberately long display name";
const longId = "vcrd_0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const longTarget = "https://mcp.example.test/organizations/production/team/deployment/mcp";

async function openVault(page: Page) {
  if (process.env.OMA_VAULT_FIXTURE_URL) {
    await page.goto(process.env.OMA_VAULT_FIXTURE_URL);
    await expect(page.getByRole("table")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return;
  }
  const date = "2026-08-31T10:00:00.000Z";
  const vault = { id: "vault-overflow", type: "vault", display_name: "Vault overflow fixture", archived_at: null, metadata: {}, created_at: date, updated_at: date };
  const credentials = [
    { id: longId, display_name: longName, auth: { type: "static_bearer", mcp_server_url: longTarget } },
    { id: "short-id", display_name: "Short name", auth: { type: "environment_variable", secret_name: "API_KEY" } },
  ].map((item) => ({ ...item, type: "vault_credential", vault_id: vault.id, archived_at: null, metadata: {}, created_at: date, updated_at: date }));
  await page.addInitScript(() => localStorage.setItem("oma-locale", "en"));
  // Every request is either a local static asset or a synthetic fixture; no backend/credentials.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
    if (url.pathname === "/auth/get-session") return route.fulfill({ json: {
      session: { id: "fixture-session", token: "fixture", userId: "u", createdAt: date, updatedAt: date, expiresAt: "2099-01-01T00:00:00.000Z" },
      user: { id: "u", name: "Fixture", email: "fixture@example.test", emailVerified: true, createdAt: date, updatedAt: date },
    } });
    if (url.pathname === "/branding/branding.json") return route.fulfill({ json: {} });
    if (url.pathname.startsWith("/v1/")) {
      if (url.pathname === `/v1/vaults/${vault.id}`) return route.fulfill({ json: vault });
      if (url.pathname === `/v1/vaults/${vault.id}/credentials`) return route.fulfill({ json: { data: credentials, has_more: false, next_page: null } });
      if (url.pathname === "/v1/oma/me/tenants") return route.fulfill({ json: { data: [{ id: "t", name: "Fixture", role: "owner" }] } });
      return route.fulfill({ json: { data: [], has_more: false, next_cursor: null, next_page: null } });
    }
    if (/^\/(auth|auth-info|matter|health|linear|github)(\/|$)/.test(url.pathname)) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto(`/vaults/${vault.id}`);
  await expect(page.getByRole("table")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test("Vault columns contain long text and horizontally scroll without overlapping at desktop and mobile", async ({ page }, testInfo) => {
  await openVault(page);
  for (const width of [1920, 1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const table = page.getByRole("table");
    const geometry = await table.evaluate((node) => {
      const row = node.querySelector("tbody tr")!;
      return Array.from(row.children).map((cell) => ({
        width: cell.clientWidth, scrollWidth: cell.scrollWidth,
        left: cell.getBoundingClientRect().left, right: cell.getBoundingClientRect().right,
      }));
    });
    // The original fixed 7-way split allows names, IDs, dates and buttons to cross cell boundaries.
    expect(geometry.every((cell) => cell.scrollWidth <= cell.width + 1)).toBe(true);
    const surface = page.getByTestId("credential-list-surface");
    if (width === 375) expect(await surface.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await surface.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    const actions = table.locator("tbody tr").first().getByRole("button");
    await expect(actions.getByText("Edit", { exact: true })).toBeVisible();
    await expect(actions.getByText("Delete", { exact: true })).toBeVisible();
    await surface.evaluate((node) => { node.scrollLeft = 0; });
    await page.screenshot({ path: testInfo.outputPath(`vault-${width}.png`) });
  }
});

test("shared DataTable text plays while custom controls remain stationary", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?data-table");
  const table = page.getByTestId("data-body-table");
  const name = table.getByTitle("A deliberately long shared table label that must stay inside its cell");
  const text = name.locator("span");
  await expect(name).toHaveAttribute("data-overflow", "true");
  await name.focus();
  const result = await text.evaluate(async (node) => {
    const animation = node.getAnimations()[0];
    const duration = animation.effect!.getTiming().duration as number;
    animation.pause(); animation.currentTime = duration / 2;
    await new Promise(requestAnimationFrame);
    const halfway = new DOMMatrix(getComputedStyle(node).transform).m41;
    animation.finish(); await new Promise(requestAnimationFrame);
    return { halfway, travel: node.scrollWidth - node.parentElement!.clientWidth };
  });
  expect(result.halfway).toBeCloseTo(-result.travel / 2, 0);
  await expect(name).toHaveAttribute("data-at-end", "true");
  // Same geometry must not clear a completed mask or restart the animation.
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(name).toHaveAttribute("data-at-end", "true");
  await expect(name).toBeFocused();
  await page.mouse.move(0, 0);
  await name.evaluate((node) => (node as HTMLElement).blur());
  await expect(text).toHaveCSS("transform", "none");
  const short = table.getByTitle("Short");
  await expect(short).toHaveAttribute("data-overflow", "false");
  await short.hover();
  await expect(short.locator("span")).toHaveCSS("transform", "none");
  const inspect = table.getByRole("button", { name: "Inspect" }).first();
  expect(await inspect.evaluate((node) => node.closest(".console-overflow-text"))).toBeNull();
  await inspect.click();
  await expect(page.getByRole("status")).toHaveText("Inspected: 1");
  await table.getByRole("checkbox").first().check();
  await expect(table.getByRole("checkbox").first()).toBeChecked();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await name.hover(); await name.focus();
  expect(await text.evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(text).toHaveCSS("transform", "none");
  await page.screenshot({ path: testInfo.outputPath("shared-data-table.png") });
});

test("only overflowing Vault text fades and plays linearly to the end on hover/focus, resets and respects reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openVault(page);
  const name = page.getByTitle(longName);
  const text = name.locator("span");
  await expect(name).toHaveAttribute("data-overflow", "true");
  expect(await name.evaluate((node) => getComputedStyle(node).maskImage)).toContain("linear-gradient");
  await expect(name).toHaveCSS("overflow-x", "hidden");
  await expect(text).toHaveCSS("transform", "none");
  await name.hover();
  const playback = await text.evaluate(async (node) => {
    const animation = node.getAnimations()[0];
    if (!animation) return null;
    const duration = animation.effect!.getTiming().duration as number;
    animation.pause();
    const offsets = [];
    for (const fraction of [0.25, 0.5, 1]) {
      animation.currentTime = duration * fraction;
      await new Promise(requestAnimationFrame);
      offsets.push(new DOMMatrix(getComputedStyle(node).transform).m41);
    }
    animation.finish();
    await new Promise(requestAnimationFrame);
    return { duration, offsets, travel: node.scrollWidth - node.parentElement!.clientWidth, endRight: node.getBoundingClientRect().right, viewportRight: node.parentElement!.getBoundingClientRect().right };
  });
  expect(playback).not.toBeNull();
  expect(playback!.offsets[0]).toBeCloseTo(-playback!.travel / 4, 0);
  expect(playback!.offsets[1]).toBeCloseTo(-playback!.travel / 2, 0);
  expect(playback!.offsets[2]).toBeCloseTo(-playback!.travel, 0);
  expect(playback!.duration / 1000).toBeCloseTo(playback!.travel / 40, 1);
  expect(playback!.endRight).toBeCloseTo(playback!.viewportRight, 0);
  // At the end only the hidden leading edge fades: the final characters stay readable.
  await expect(name).toHaveAttribute("data-at-end", "true");
  expect(await name.evaluate((node) => getComputedStyle(node).maskImage)).toMatch(/^linear-gradient\(to right, rgba\(0, 0, 0, 0\)/);
  await page.mouse.move(0, 0);
  await expect(text).toHaveCSS("transform", "none");
  await name.focus();
  await expect.poll(() => text.evaluate((node) => node.getAnimations().length)).toBe(1);
  await name.evaluate((node) => (node as HTMLElement).blur());
  await expect(text).toHaveCSS("transform", "none");

  const short = page.getByTitle("Short name");
  await expect(short).toHaveAttribute("data-overflow", "false");
  await expect(short).not.toHaveAttribute("tabindex");
  await short.hover();
  expect(await short.locator("span").evaluate((node) => node.getAnimations().length)).toBe(0);
  await expect(short).toHaveCSS("mask-image", "none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await name.hover();
  await name.focus();
  await expect(text).toHaveCSS("transform", "none");
  expect(await text.evaluate((node) => node.getAnimations().length)).toBe(0);
});
