import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { server } from "../../mocks/server";
import { I18nProvider } from "../../i18n";
import type { AgentRecord } from "../../types/agent";
import { AgentFormDialog } from "./AgentFormDialog";

// Keep the actual dialog, Radix controls, codec and API client; only HTTP is stubbed.
const requests: Record<string, unknown>[] = [];
const oma = { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } };
const toolset = (mode = "always_allow", configs: object[] = []) => ({
  type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: mode } }, configs,
});
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
beforeEach(() => {
  requests.length = 0;
  server.use(
    http.get("/v1/oma/model_cards", () => HttpResponse.json({ data: [], has_more: false })),
    http.get("/v1/oma/harnesses", () => HttpResponse.json({ object: "list", default_harness_id: "pi", data: [
      { id: "pi", label: "Pi", description: "Host", execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [] },
      { id: "acp-sandbox", label: "ACP", description: "Sandbox", execution: { placement: "sandbox" }, capabilities: { runtime_binding: false }, requirements: ["acp.agent.command|acp.agent.registry"] },
    ] })),
    http.post("/v1/agents/:id", async ({ request }) => { requests.push(await request.json() as Record<string, unknown>); return HttpResponse.json({ id: "a" }); }),
    http.post("/v1/agents", async ({ request }) => { requests.push(await request.json() as Record<string, unknown>); return HttpResponse.json({ id: "new" }, { status: 201 }); }),
  );
});
async function open(tools: object[] = [toolset()], harness = "acp-sandbox", create = false) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><I18nProvider><AgentFormDialog open onClose={() => {}} allAgents={[]} customSkills={[]} modelCards={[]}
    agent={create ? undefined : { id: "a", version: 1, name: "A", model: "m", tools, mcp_servers: [{ name: "docs", type: "url", url: "https://docs.example.test" }], _oma: { ...oma, harness } } as unknown as AgentRecord} /></I18nProvider></MemoryRouter></QueryClientProvider>);
  if (create) fireEvent.click(screen.getByRole("button", { name: /^Deep researcher/ }));
  await waitFor(() => expect(screen.queryByText("Loading harness catalog…")).not.toBeInTheDocument());
}
function toolsTab() { fireEvent.click(screen.getByRole("tab", { name: /^Tools/ })); }
function code(payload?: object) {
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  if (payload) fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify(payload) } });
  return JSON.parse((screen.getByRole("textbox") as HTMLTextAreaElement).value);
}
async function choose(name: string, option: RegExp) {
  fireEvent.keyDown(screen.getByRole("combobox", { name }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
it.each(["always_ask", "auto", "always_allow"])("saves ACP global %s through the real client, with availability but no per-tool permissions", async (mode) => {
  await open([toolset("always_allow", [{ name: "read", enabled: true, permission_policy: { type: "always_allow" } }])]);
  toolsTab();
  expect(screen.queryByText("Per-tool overrides")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Global permission mode" }), { key: "ArrowDown" });
  expect(within(await screen.findByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`\\(${mode}\\)`) }));
  if (mode === "auto") expect(screen.getByText(/不等同于 Claude Managed Agents/)).toBeInTheDocument();
  await choose("bash availability", /^disabled$/);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "read availability" }), { key: "ArrowDown" });
  expect(within(await screen.findByRole("listbox")).getAllByRole("option").map(el => el.textContent)).toEqual(["default (enabled)", "enabled", "disabled"]);
  fireEvent.click(screen.getByRole("option", { name: /^enabled$/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({
    type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: mode } },
    configs: [{ name: "read", enabled: true }, { name: "bash", enabled: false }],
  })]));
});
it("keeps non-ACP per-tool permission controls", async () => {
  await open([toolset()], "pi"); toolsTab();
  await choose("bash override", /^always_ask$/);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }] })]));
});
it.each([
  ["built-in", [toolset("always_allow", [{ name: "bash", permission_policy: { type: "always_allow" } }])], "tools[0].configs[0].permission_policy"],
  ["MCP", [toolset(), { type: "mcp_toolset", mcp_server_name: "docs", configs: [{ name: "search", permission_policy: { type: "always_allow" } }] }], "tools[1].configs[0].permission_policy"],
  ["different MCP default", [toolset("auto"), { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "always_allow" } } }], "tools[1].default_config.permission_policy"],
])("rejects explicit %s policy in code and cannot launder it through Form", async (_label, tools, path) => {
  await open(); code({ tools });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(path);
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expect(screen.getByRole("alert")).toHaveTextContent(path);
  expect(screen.getByRole("textbox")).toHaveValue(JSON.stringify({ tools }));
});
it("does not erase a legacy conflict by changing the global mode to match it", async () => {
  await open([toolset("always_allow", [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }])]);
  toolsTab();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await choose("Global permission mode", /\(always_ask\)/);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await choose("bash availability", /^enabled$/);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
});
it("blocks legacy rename-only code updates but permits explicit repair", async () => {
  await open([toolset("always_allow", [{ name: "bash", enabled: true, permission_policy: { type: "auto" } }])]);
  code({ name: "renamed" });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("tools[0].configs[0].permission_policy");
  expect(requests).toHaveLength(0);
  code({ tools: [toolset("auto", [{ name: "bash", enabled: false }])] });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
});
it("creates an ACP agent in code mode with a global mode and non-permission config", async () => {
  await open([], "pi", true);
  code({ name: "ACP", model: "m", _oma: oma, tools: [toolset("auto", [{ name: "web_fetch", allowed_domains: ["example.com"] }])] });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.tools).toEqual([toolset("auto", [{ name: "web_fetch", allowed_domains: ["example.com"] }])]);
});
it("does not silently remove a legacy permission on a disabled tool", async () => {
  await open([toolset("always_allow", [{ name: "bash", enabled: false, permission_policy: { type: "always_ask" } }])]);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(code().tools[0].configs[0]).toEqual({ name: "bash", enabled: false, permission_policy: { type: "always_ask" } });
});
it("keeps the global selector usable with tools disabled and displays an enabled-only exception", async () => {
  await open([{ ...toolset("auto", [{ name: "bash", enabled: true }]), default_config: { enabled: false, permission_policy: { type: "auto" } } }]);
  toolsTab();
  expect(screen.getByRole("combobox", { name: "Global permission mode" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "bash availability" })).toHaveTextContent("enabled");
  await choose("Global permission mode", /\(always_ask\)/);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({
    default_config: { enabled: false, permission_policy: { type: "always_ask" } }, configs: [{ name: "bash", enabled: true }],
  })]));
});
it("allows explicitly clearing a disabled legacy tool policy while keeping the tool disabled", async () => {
  await open([toolset("always_allow", [{ name: "bash", enabled: false, permission_policy: { type: "always_ask" } }])]);
  toolsTab();
  await choose("bash availability", /^enabled$/);
  await choose("bash availability", /^disabled$/);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ configs: [{ name: "bash", enabled: false }] })]));
});
it("switches from host per-tool controls to ACP global controls using the existing harness picker", async () => {
  await open([toolset()], "pi");
  await choose("Harness", /^ACP \(acp-sandbox\)$/);
  toolsTab();
  expect(screen.getByRole("combobox", { name: "Global permission mode" })).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "bash override" })).not.toBeInTheDocument();
  await choose("Global permission mode", /\(auto\)/);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?._oma).toMatchObject({ harness: "acp-sandbox" });
});
it("blocks legacy MCP conflicts in form and keeps JSON available for explicit repair", async () => {
  await open([toolset(), { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "auto" } } }]);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("tools[1].default_config.permission_policy");
  expect(code().tools[1].default_config.permission_policy.type).toBe("auto");
});
it("repairs a legacy permission by explicitly choosing inherited availability", async () => {
  await open([toolset("always_allow", [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }])]);
  toolsTab();
  await choose("bash availability", /^default/);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  const tools = requests[0]?.tools as Array<{ type: string; configs?: unknown[] }>;
  expect(tools.find(tool => tool.type === "agent_toolset_20260401")?.configs ?? []).toEqual([]);
});
it("shows the blocking MCP field path on the Tools tab, not only Basic", async () => {
  await open([toolset(), { type: "mcp_toolset", mcp_server_name: "docs", default_config: { permission_policy: { type: "auto" } } }]);
  toolsTab();
  expect(screen.getByRole("alert")).toHaveTextContent("tools[1].default_config.permission_policy");
});
