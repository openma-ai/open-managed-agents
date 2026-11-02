import { expect, test, type Page } from "@playwright/test";

// Accurate public endpoint fixture. These tests do not assert real deployment integration.
const catalog = {
  object: "list", default_harness_id: "team-host",
  data: [
    { id: "team-host", label: "Team host", description: "Registered host implementation", execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [] },
    { id: "team-custom", label: "Team custom", description: "Custom deployment implementation", execution: { placement: "unknown" }, capabilities: { runtime_binding: null }, requirements: [] },
    { id: "acp-sandbox", label: "Sandbox ACP", description: "Uses configured ACP command", execution: { placement: "sandbox" }, capabilities: { runtime_binding: false }, requirements: ["acp.agent.command"] },
  ],
};
async function open(page: Page, edit = false, catalogResponse: () => typeof catalog | null = () => catalog, harness = "team-custom") {
  const writes: Record<string, any>[] = [];
  await page.addInitScript(() => localStorage.setItem("oma-locale", "en"));
  await page.route("**/branding/branding.json", (route) => route.fulfill({ json: {} }));
  await page.route("**/auth/get-session**", (route) => route.fulfill({ json: {
    session: { id: "s", token: "test", userId: "u", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() },
    user: { id: "u", name: "Test", email: "test@openma.test", emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  } }));
  const agent = { id: "a", type: "agent", version: 1, name: "Harness fixture", model: "tenant-model", system: "", tools: [], created_at: new Date().toISOString(),
    _oma: { harness, acp: { agent: { command: "/existing", env: { KEEP: "non-secret-fixture" } } }, runtime_binding: { runtime_id: "rt", acp_agent_id: "other", local_skill_blocklist: ["private"] }, future: { keep: true } } };
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/oma/harnesses") {
      const response = catalogResponse();
      return response ? route.fulfill({ json: response }) : route.fulfill({ status: 503, json: { error: "Catalog unavailable" } });
    }
    if (route.request().method() === "POST" && path.startsWith("/v1/agents")) {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...agent, ...route.request().postDataJSON() } });
    }
    if (path === "/v1/agents/a") return route.fulfill({ json: agent });
    if (path === "/v1/oma/me/tenants") return route.fulfill({ json: { data: [{ id: "t", name: "Test", role: "owner" }] } });
    if (path === "/v1/oma/model_cards/mc") return route.fulfill({ json: { id: "mc", model_id: "tenant-model", model: "tenant-model", is_default: true } });
    if (path === "/v1/oma/model_cards") return route.fulfill({ json: { data: [{ id: "mc", model_id: "tenant-model", model: "tenant-model", is_default: true }], next_cursor: null } });
    return route.fulfill({ json: { data: [], next_cursor: null, next_page: null } });
  });
  await page.goto(edit ? "/agents/a" : "/agents");
  if (edit) await page.getByRole("button", { name: /Edit/i }).first().click();
  else {
    await page.getByRole("button", { name: /New agent$/ }).first().click();
    await page.getByRole("button", { name: /^Deep researcher/ }).click();
  }
  return { writes, agent };
}

for (const width of [1280, 375]) {
  test(`catalog selection, required fields and keyboard at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { writes } = await open(page);
    const picker = page.getByRole("combobox", { name: "Harness", exact: true });
    await expect(picker).toHaveText("Default (team-host)");
    await expect(page.getByText("Execution strategy: Control-plane process")).toBeVisible();
    await picker.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option")).toHaveCount(4);
    await expect(page.getByRole("option", { name: /Sandbox ACP/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("End");
    await expect(page.getByRole("option", { name: "Team custom (team-custom)", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker).toHaveText("Team custom (team-custom)");
    const region = page.getByRole("region", { name: "Harness configuration" });
    expect(await region.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`harness-${width}.png`) });
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const config = JSON.parse(await page.getByRole("textbox").inputValue());
    expect(config._oma).toEqual({ harness: "team-custom" });
    config._oma = { harness: "acp-sandbox", acp: { agent: { command: "/provided" }, extra: true }, runtime_binding: { runtime_id: "rt", acp_agent_id: "local" }, future: { keep: true } };
    await page.getByRole("textbox").fill(JSON.stringify(config));
    await page.getByRole("button", { name: "YAML", exact: true }).click();
    await page.getByRole("button", { name: "Form", exact: true }).click();
    await expect(picker).toHaveText("Sandbox ACP (acp-sandbox)");
    await picker.click();
    await page.getByRole("option", { name: "Team host (team-host)", exact: true }).click();
    await page.getByRole("button", { name: "JSON", exact: true }).click();
    const saved = JSON.parse(await page.getByRole("textbox").inputValue());
    expect(saved._oma).toEqual({ ...config._oma, harness: "team-host" });
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]._oma).toEqual(saved._oma);
  });
}

for (const requirement of ["appendable_prompts", "aux_model.id"]) {
  test(`form edits satisfy ${requirement} before saving without code mode`, async ({ page }, testInfo) => {
    const response = { ...catalog, data: [
      ...catalog.data,
      { ...catalog.data[0], id: "form-host", label: "Form host", requirements: [requirement] },
    ] };
    const { writes, agent } = await open(page, true, () => response, "form-host");
    const picker = page.getByRole("combobox", { name: "Harness", exact: true });
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    await expect(page.getByText(`Missing required configuration: _oma.${requirement}.`, { exact: false })).toBeVisible();
    await expect(save).toBeDisabled();
    if (requirement === "appendable_prompts") {
      await page.getByLabel("Appendable prompt IDs").fill("prompt_123");
    } else {
      await page.getByRole("combobox").filter({ hasText: /^None$/ }).click();
      await page.getByRole("option", { name: "tenant-model", exact: true }).click();
    }
    await expect(save).toBeEnabled();
    await expect(picker).toHaveAttribute("aria-invalid", "false");
    await expect(page.getByText(/Missing required configuration/)).toHaveCount(0);
    await picker.click();
    await expect(page.getByRole("option", { name: "Form host (form-host)", exact: true })).not.toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: "Form host (form-host)", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("form-requirement-satisfied.png") });
    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]._oma).toEqual({ ...agent._oma, ...(requirement === "appendable_prompts"
      ? { appendable_prompts: ["prompt_123"] } : { aux_model: { id: "tenant-model" } }) });
  });
}

test("directory failure and empty states retry without fallback", async ({ page }, testInfo) => {
  let response: typeof catalog | null = null;
  await open(page, false, () => response);
  await expect(page.getByText(/Unable to load harness catalog/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Agent", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("catalog-unavailable.png") });
  response = { ...catalog, data: [] };
  await page.getByRole("button", { name: "Retry harness catalog" }).click();
  await expect(page.getByText(/No harnesses are registered/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Agent", exact: true })).toBeDisabled();
  response = catalog;
  await page.getByRole("button", { name: "Retry harness catalog" }).click();
  await expect(page.getByRole("combobox", { name: "Harness", exact: true })).toHaveText("Default (team-host)");
  await expect(page.getByRole("button", { name: "Create Agent", exact: true })).toBeEnabled();
});

test("edit default clear survives code round-trip and preserves all other execution config", async ({ page }) => {
  const { writes, agent } = await open(page, true);
  await expect(page.getByRole("combobox", { name: "Harness", exact: true })).toHaveText("Team custom (team-custom)");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await page.getByRole("textbox").fill(JSON.stringify({ _oma: { harness: null } }));
  await page.getByRole("button", { name: "YAML", exact: true }).click();
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Harness", exact: true })).toHaveText("Default (team-host)");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]._oma).toEqual({ ...agent._oma, harness: null });
});
