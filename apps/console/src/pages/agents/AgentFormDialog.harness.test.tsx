import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { delay, http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { I18nProvider } from "../../i18n";
import { AgentFormDialog } from "./AgentFormDialog";
import type { AgentRecord } from "../../types/agent";

const writes = vi.hoisted(() => ({ create: vi.fn(async () => ({ id: "new" })), update: vi.fn(async (_id: string, _payload: Record<string, unknown>) => ({ id: "a" })) }));
vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => ({ agents: writes }) }));
vi.mock("../../components/McpServerPickerModal", () => ({ McpServerPickerModal: () => null }));
vi.mock("../../components/Combobox", () => ({ Combobox: ({ onValueChange, placeholder }: { onValueChange: (id: string, item: { model_id: string }) => void; placeholder?: string }) =>
  <button onClick={() => onValueChange("aux-card", { model_id: "aux-model" })}>Choose {placeholder}</button> }));

const catalog = {
  object: "list", default_harness_id: "custom-host",
  data: [
    { id: "custom-host", label: "Custom host", description: "Deployment implementation", execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [] },
    { id: "custom-sandbox", label: "Custom sandbox", description: "Needs advanced config", execution: { placement: "sandbox" }, capabilities: { runtime_binding: null }, requirements: ["acp.agent.command"] },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json(catalog)));
});
function open(oma?: Record<string, unknown>, edit = false) {
  render(<MemoryRouter><I18nProvider><AgentFormDialog open onClose={() => {}} allAgents={[]} customSkills={[]} modelCards={[]}
    agent={edit ? { id: "a", version: 1, name: "A", model: "m", tools: [], ...(oma ? { _oma: oma } : {}) } as unknown as AgentRecord : undefined} /></I18nProvider></MemoryRouter>);
  if (!edit) fireEvent.click(screen.getByRole("button", { name: /^Deep researcher/ }));
}
function json() {
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  return JSON.parse((screen.getByRole("textbox") as HTMLTextAreaElement).value);
}

it("loads deployment default and custom implementations, without rewriting omitted harness", async () => {
  open();
  expect(await screen.findByRole("combobox", { name: "Harness" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent("Default (custom-host)"));
  expect(screen.getByText(/Control-plane process/)).toBeInTheDocument();
  expect(json()._oma?.harness).toBeUndefined();
});

it.each([undefined, null, "default", "custom-host"])("preserves untouched harness %s on edit and code round-trip", async (harness) => {
  const oma = { ...(harness === undefined ? {} : { harness }), acp: { agent: { command: "/existing" }, future: true }, runtime_binding: { runtime_id: "rt", acp_agent_id: "agent", extension: true }, future: { keep: true } };
  open(oma, true);
  await screen.findByText(/Control-plane process/);
  const first = json();
  expect(first._oma).toEqual(oma);
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Renamed" } });
  expect(json()._oma).toEqual(oma);
});

it("keeps an explicit harness clear through JSON → YAML → Form → save", async () => {
  open({ harness: "custom-sandbox", acp: { agent: { command: "/existing" } }, runtime_binding: { runtime_id: "rt", acp_agent_id: "local" }, future: true }, true);
  await screen.findByRole("combobox", { name: "Harness" });
  json();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify({ _oma: { harness: null } }) } });
  fireEvent.click(screen.getByRole("button", { name: "YAML" }));
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(writes.update).toHaveBeenCalled());
  expect(writes.update.mock.calls[0]?.[1]).toMatchObject({ _oma: { harness: null, acp: { agent: { command: "/existing" } }, runtime_binding: { runtime_id: "rt", acp_agent_id: "local" }, future: true } });
});

it("shows unknown existing IDs without replacing them and rejects their submission", async () => {
  open({ harness: "unregistered-custom", future: true }, true);
  expect(await screen.findByText(/not registered/i)).toBeInTheDocument();
  expect(json()._oma).toEqual({ harness: "unregistered-custom", future: true });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/not registered/i);
  expect(writes.update).not.toHaveBeenCalled();
});

it("blocks a missing required advanced field even in JSON, then accepts the real configured field", async () => {
  open();
  await screen.findByText(/Control-plane process/);
  json();
  const config = { name: "Sandbox", model: "m", _oma: { harness: "custom-sandbox", future: true } };
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify(config) } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  expect(await screen.findByText(/Missing required configuration: _oma.acp.agent.command/)).toBeInTheDocument();
  expect(writes.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify({ ...config, _oma: { ...config._oma, acp: { agent: { command: "/provided-by-user" } } } }) } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(writes.create).toHaveBeenCalled());
});

it("accepts either alternative of a one-of requirement and names both when neither is set", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ ...catalog, data: [
    ...catalog.data,
    { ...catalog.data[1], id: "acp-sandbox", requirements: ["acp.agent.command|acp.agent.registry"] },
  ] })));
  open();
  await screen.findByText(/Control-plane process/);
  json();
  const config = { name: "Sandbox", model: "m", _oma: { harness: "acp-sandbox" } };
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify(config) } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  expect(await screen.findByText(/Missing required configuration: _oma.acp.agent.command or _oma.acp.agent.registry\./)).toBeInTheDocument();
  expect(writes.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify({ ...config, _oma: { ...config._oma, acp: { agent: { registry: "claude-acp@0.94.0" } } } }) } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(writes.create).toHaveBeenCalled());
});

it("lists one-of requirements of unavailable choices as alternatives, not raw paths", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ ...catalog, data: [
    ...catalog.data,
    { ...catalog.data[1], id: "acp-sandbox", label: "ACP sandbox", requirements: ["acp.agent.command|acp.agent.registry"] },
  ] })));
  open();
  const hint = await screen.findByText(/Unavailable choices need JSON \/ YAML configuration/);
  expect(hint).toHaveTextContent("ACP sandbox: _oma.acp.agent.command or _oma.acp.agent.registry");
  expect(hint.textContent).not.toContain("|");
});

it("validates required appendable prompts against the current form and saves without switching modes", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ ...catalog, data: [
    ...catalog.data,
    { ...catalog.data[0], id: "prompt-host", requirements: ["appendable_prompts"] },
  ] })));
  open({ harness: "prompt-host" }, true);
  await screen.findByText(/Missing required configuration: _oma.appendable_prompts/);
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Appendable prompt IDs"), { target: { value: "prompt_123" } });
  expect(save).toBeEnabled();
  expect(screen.queryByText(/Missing required configuration/)).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Harness" })).toHaveAttribute("aria-invalid", "false");
  fireEvent.click(save);
  await waitFor(() => expect(writes.update).toHaveBeenCalledWith("a", expect.objectContaining({
    _oma: { harness: "prompt-host", appendable_prompts: ["prompt_123"] },
  })));
});

it("validates the required auxiliary model against the current form and saves without switching modes", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ ...catalog, data: [
    ...catalog.data,
    { ...catalog.data[0], id: "aux-host", requirements: ["aux_model.id"] },
  ] })));
  open({ harness: "aux-host" }, true);
  await screen.findByText(/Missing required configuration: _oma.aux_model.id/);
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Choose None" }));
  expect(save).toBeEnabled();
  expect(screen.queryByText(/Missing required configuration/)).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Harness" })).toHaveAttribute("aria-invalid", "false");
  fireEvent.click(save);
  await waitFor(() => expect(writes.update).toHaveBeenCalledWith("a", expect.objectContaining({
    _oma: { harness: "aux-host", aux_model: { id: "aux-model" } },
  })));
});

it.each([
  ["a configured requirement", { harness: "custom-sandbox", acp: { agent: { command: "/x" } } }],
  ["the requirement-free default", undefined],
])("surfaces the real form error instead of a misleading requirement when metadata is invalid (%s)", async (_label, oma) => {
  open(oma, true);
  await screen.findByText(/Execution strategy:/);
  const save = screen.getByRole("button", { name: "Save changes" });
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Metadata (JSON)"), { target: { value: "{bad" } });
  expect(save).toBeDisabled();
  expect(screen.getByText(/Invalid metadata/i)).toBeInTheDocument();
  expect(screen.queryByText(/Missing required configuration/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Metadata (JSON)"), { target: { value: "{}" } });
  expect(save).toBeEnabled();
  expect(screen.queryByText(/Invalid metadata/i)).not.toBeInTheDocument();
});

it("does not carry a previously previewed harness into an omitted update patch", async () => {
  open({ harness: "custom-sandbox", acp: { agent: { command: "/existing" } } }, true);
  await screen.findByText("Execution strategy: Sandbox");
  json();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify({ _oma: { harness: "custom-host" } }) } });
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  json();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify({ name: "Rename only" }) } });
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expect(screen.getByText("Execution strategy: Sandbox")).toBeInTheDocument();
  expect(json()._oma).not.toHaveProperty("harness");
});

it("preserves advanced ACP, runtime binding and unknown nulls during an untouched round-trip", async () => {
  const oma = { harness: "custom-host", acp: null, runtime_binding: null, future: null };
  open(oma, true);
  await screen.findByText(/Control-plane process/);
  json();
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  expect(json()._oma).toEqual(oma);
});

it("reports an unavailable catalog and can retry without falling back", async () => {
  server.use(http.get("/v1/oma/harnesses", () => new HttpResponse(null, { status: 503 })));
  open();
  expect(await screen.findByText(/Unable to load harness catalog/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json(catalog)));
  fireEvent.click(screen.getByRole("button", { name: "Retry harness catalog" }));
  await screen.findByText(/Control-plane process/);
});

it("blocks submission while the directory is loading but leaves JSON editable", async () => {
  server.use(http.get("/v1/oma/harnesses", async () => { await delay(100); return HttpResponse.json(catalog); }));
  open();
  expect(screen.getByText("Loading harness catalog…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  json();
  expect(screen.getByRole("textbox")).toBeEnabled();
  await waitFor(() => expect(screen.queryByText("Loading harness catalog…")).toBeNull());
});

it("can display a registered implementation when deployment default is null", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ ...catalog, default_harness_id: null })));
  open({ harness: "custom-host" }, true);
  expect(await screen.findByText("Execution strategy: Control-plane process")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

it("rejects malformed catalog metadata instead of inventing a fallback", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ object: "list", data: [{ id: "bad" }], default_harness_id: "bad" })));
  open();
  expect(await screen.findByText(/Unable to load harness catalog/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
});

it("shows an empty directory and no deployment default, without manufacturing options", async () => {
  server.use(http.get("/v1/oma/harnesses", () => HttpResponse.json({ object: "list", data: [], default_harness_id: null })));
  open();
  expect(await screen.findByText(/No harnesses are registered/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  expect(json()._oma?.harness).toBeUndefined();
});
