import { expect, test } from "@playwright/test";

test("page startup loader matches Backchat geometry and reduced-motion behavior", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("oma-locale", "zh-CN"));
  await page.route("**/branding/branding.json", (route) => route.fulfill({ json: {} }));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/auth/get-session**", async (route) => { await pending; await route.fulfill({ json: null }); });
  try {
    await page.goto("/agents");
    const loader = page.getByRole("status", { name: "加载中…" });
    await expect(loader).toBeVisible();
    await expect(loader).toHaveAttribute("viewBox", "240 244 548 454");
    const size = await loader.boundingBox();
    expect(size?.width).toBe(88);
    expect(size?.height).toBe(72);
    const dots = loader.locator("circle");
    await expect(dots).toHaveCount(3);
    expect(await dots.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).animationDelay))).toEqual(["0s", "0.18s", "0.36s"]);
    await expect(dots.first()).toHaveCSS("animation-duration", "1.2s");
    await page.screenshot({ path: testInfo.outputPath("startup-loader.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(dots.first()).toHaveCSS("animation-name", "none");
    await expect(dots.first()).toHaveCSS("opacity", "0.6");
    await page.screenshot({ path: testInfo.outputPath("startup-loader-reduced-motion.png") });
  } finally { release(); }
});
