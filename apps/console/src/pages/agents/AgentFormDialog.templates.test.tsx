import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { AgentFormDialog } from "./AgentFormDialog";

vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => ({}) }));
vi.mock("../../components/McpServerPickerModal", () => ({ McpServerPickerModal: () => null }));
vi.mock("../../components/Combobox", () => ({ Combobox: () => null }));

function openTemplates() {
  render(
    <MemoryRouter><I18nProvider>
      <AgentFormDialog open onClose={() => {}} allAgents={[]} customSkills={[]} modelCards={[]} />
    </I18nProvider></MemoryRouter>,
  );
  return userEvent.setup();
}

it.each([
  ["Field monitor", ["Notion"]],
  ["Support agent", ["Notion", "Slack"]],
  ["Incident commander", ["Sentry", "Linear", "Slack", "GitHub"]],
  ["Feedback miner", ["Slack", "Notion", "Asana"]],
  ["Sprint retro facilitator", ["Linear", "Slack", "Word (docx)"]],
  ["Support-to-eng escalator", ["Intercom", "Atlassian", "Slack"]],
  ["Data analyst", ["Amplitude"]],
])("renders %s connectors and skills as named local icons, not text chips", (name, labels) => {
  openTemplates();
  const card = screen.getByRole("button", { name: new RegExp(`^${name}`) });
  expect(within(card).getAllByRole("img")).toHaveLength(labels.length);
  for (const label of labels) {
    const icon = within(card).getByRole("img", { name: label });
    expect(icon).toHaveAttribute("title", label);
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(icon).toHaveTextContent("");
  }
  expect(card.querySelector("img")).toBeNull();
});

it("keeps tag search case-insensitive and shows the existing empty state", async () => {
  const user = openTemplates();
  const search = screen.getByRole("textbox", { name: "Search templates" });
  await user.type(search, "GITHUB");
  expect(screen.getByRole("button", { name: /^Incident commander/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Blank agent config/ })).toBeNull();
  await user.clear(search);
  await user.type(search, "no-matching-template");
  expect(screen.getByText("No templates match your search.")).toBeInTheDocument();
});

it("selects a template by keyboard and preserves its configuration", async () => {
  const user = openTemplates();
  const card = screen.getByRole("button", { name: /^Incident commander/ });
  card.focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "JSON" }));
  const config = JSON.parse((screen.getByRole("textbox") as HTMLTextAreaElement).value);
  expect(config.name).toBe("Incident commander");
  expect(config.mcp_servers.map((entry: { name: string }) => entry.name)).toEqual([
    "sentry", "linear", "slack", "github",
  ]);
  await user.click(screen.getByRole("button", { name: /Templates/ }));
  expect(screen.getByRole("textbox", { name: "Search templates" })).toHaveValue("");
  const blank = screen.getByRole("button", { name: /^Blank agent config/ });
  expect(within(blank).queryAllByRole("img")).toHaveLength(0);
  blank.focus();
  await user.keyboard(" ");
  await user.click(screen.getByRole("button", { name: "JSON" }));
  const blankConfig = JSON.parse((screen.getByRole("textbox") as HTMLTextAreaElement).value);
  expect(blankConfig.name).toBe("");
  expect(blankConfig.mcp_servers ?? []).toEqual([]);
});
