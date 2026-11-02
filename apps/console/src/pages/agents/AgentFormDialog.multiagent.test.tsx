import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentFormDialog } from "./AgentFormDialog";
import type { AgentRecord } from "../../types/agent";
const update = vi.hoisted(() => vi.fn(async () => ({ id: "a" })));
vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => ({ agents: { update } }) }));
vi.mock("../../components/McpServerPickerModal", () => ({ McpServerPickerModal: () => null }));
vi.mock("../../components/Combobox", () => ({ Combobox: () => null }));
beforeEach(() => update.mockClear());
it("saves enabled inline-only configuration through the API", async () => {
  open();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用子 Agent" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith("a", expect.objectContaining({
    multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] } }, version: 1,
  })));
});
it("removes self, toggles inline and disables subagents", () => {
  open({ type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: [{ type: "self" }] } });
  fireEvent.click(screen.getByRole("button", { name: "移除引用 1" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "允许 inline Agent" }));
  expect(json().multiagent.subagents).toEqual({ type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] });
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "启用子 Agent" }));
  expect(json().multiagent.subagents).toEqual({ type: "disabled" });
});
it.each([{}, { multiagent: null }, { multiagent: { type: "multiagent_20261001", advisor: null, subagents: { type: "enabled", predefined_agents: null } } }])("keeps code update patch semantics through form: %j", (patch) => {
  open({ type: "multiagent_20261001", subagents: { type: "disabled" } });
  json();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify(patch) } });
  fireEvent.click(screen.getByRole("button", { name: "Form" }));
  const result = json();
  expect(result.multiagent).toEqual((patch as { multiagent?: unknown }).multiagent);
  expect(Object.hasOwn(result, "multiagent")).toBe(Object.hasOwn(patch, "multiagent"));
});
it("rejects blank and duplicate IDs", () => {
  open();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用子 Agent" }));
  fireEvent.click(screen.getByRole("button", { name: "添加子 Agent" }));
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect(screen.getByRole("alert")).toHaveTextContent("ID 不能为空");
  fireEvent.change(screen.getByLabelText("Agent ID 1"), { target: { value: "child" } });
  fireEvent.click(screen.getByRole("button", { name: "添加子 Agent" }));
  fireEvent.change(screen.getByLabelText("Agent ID 2"), { target: { value: "child" } });
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect(screen.getByRole("alert")).toHaveTextContent("不能重复");
});
it("shows unsupported advisor without silently converting it, and allows code migration", () => {
  const config = { type: "multiagent_20261001", advisor: { type: "enabled" } };
  open(config);
  expect(screen.getByRole("alert")).toHaveTextContent("当前配置不受支持");
  expect(screen.queryByRole("checkbox", { name: "启用子 Agent" })).toBeNull();
  expect(json().multiagent).toEqual(config);
});
function open(multiagent?: unknown) {
  render(<MemoryRouter><I18nProvider><AgentFormDialog open onClose={() => {}} allAgents={[]} customSkills={[]} modelCards={[]} agent={{ id: "a", version: 1, name: "A", model: "m", tools: [], ...(multiagent === undefined ? {} : { multiagent }) } as unknown as AgentRecord} /></I18nProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole("tab", { name: /Multi-Agent/ }));
}
function json() { fireEvent.click(screen.getByRole("button", { name: "JSON" })); return JSON.parse((screen.getByRole("textbox") as HTMLTextAreaElement).value); }
it("supports inline-only with an empty predefined list", () => {
  open();
  fireEvent.click(screen.getByRole("checkbox", { name: "启用子 Agent" }));
  expect(json().multiagent).toEqual({ type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] } });
});
it("edits pinned and self references",  () => {
  open({ type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [{ type: "agent", id: "child", version: 2 }] } });
  fireEvent.change(screen.getByLabelText("版本 1"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "添加 self 引用" }));
  expect(json().multiagent.subagents.predefined_agents).toEqual([{ type: "agent", id: "child", version: 3 }, { type: "self" }]);
});
it.each([undefined, null, { type: "multiagent_20261001", advisor: null, subagents: { type: "enabled", inline_agents: null, predefined_agents: null } }])("preserves omitted/null on an untouched form: %j", (value) => {
  open(value);
  const payload = json();
  if (value === undefined) expect(payload).not.toHaveProperty("multiagent");
  else expect(payload.multiagent).toEqual(value);
});
it("rejects an invalid version instead of silently reverting it", () => {
  open({ type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: [{ type: "agent", id: "child", version: 2 }] } });
  fireEvent.change(screen.getByLabelText("版本 1"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  expect(screen.getByRole("alert")).toHaveTextContent("版本必须为正整数");
  expect(update).not.toHaveBeenCalled();
});
