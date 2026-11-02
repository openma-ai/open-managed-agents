import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { SkillsList } from "./SkillsList";

const SOURCE = "https://skills.example.com/team";

const state = vi.hoisted(() => ({
  sourcesAvailable: true,
  installed: [] as unknown[],
  calls: [] as { method: string; path: string; body: unknown }[],
  check: null as unknown,
}));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [
      {
        type: "skill",
        id: "skill_review",
        display_title: "code-review",
        source: "custom",
        latest_version: "1001",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
      {
        type: "skill",
        id: "skill_upload",
        display_title: "Uploaded",
        source: "custom",
        latest_version: "1002",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    error: null,
  }),
}));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => ({ skills: {} }) }));

const lock = {
  skill_id: "skill_review",
  source_url: SOURCE,
  name: "code-review",
  digest: `sha256:${"a".repeat(64)}`,
  version: "1001",
  installed_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  state.sourcesAvailable = true;
  state.installed = [lock];
  state.calls = [];
  state.check = {
    sources: [{ url: SOURCE, status: "ok", new_skills: [{ name: "triage", description: "Triage" }] }],
    skills: [{ skill_id: "skill_review", name: "code-review", source_url: SOURCE, status: "update_available" }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method, path, body });
      if (!path.startsWith("/v1/oma/skill-sources")) return Response.json({ data: [] });
      if (!state.sourcesAvailable) return Response.json({ error: "Not found" }, { status: 404 });
      if (path.endsWith("/installed")) return Response.json({ data: state.installed });
      if (path.endsWith("/discover")) {
        if (body.url === "https://bad.example") {
          return Response.json({ error: "No Agent Skills index found at https://bad.example" }, { status: 404 });
        }
        return Response.json({
          url: SOURCE,
          data: [
            { name: "code-review", description: "Review code", digest: null, installed_skill_id: "skill_review" },
            { name: "release-notes", description: "Write release notes", digest: null, installed_skill_id: null },
          ],
        });
      }
      if (path.endsWith("/install")) {
        return Response.json({
          url: SOURCE,
          data: body.skills.map((name: string) => ({ name, status: "installed", skill_id: `skill_${name}`, version: "1" })),
        });
      }
      if (path.endsWith("/check-updates")) return Response.json(state.check);
      if (path.endsWith("/update")) {
        state.check = {
          sources: [{ url: SOURCE, status: "ok", new_skills: [] }],
          skills: [{ skill_id: "skill_review", name: "code-review", source_url: SOURCE, status: "current" }],
        };
        return Response.json({
          data: [{ name: "code-review", status: "updated", skill_id: "skill_review", version: "1003" }],
        });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }),
  );
});

function show() {
  render(
    <MemoryRouter>
      <I18nProvider>
        <SkillsList />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SkillsList skill sources", () => {
  it("labels skills installed from a URL with their source", async () => {
    show();
    expect((await screen.findByText("skills.example.com/team")).parentElement).toHaveAttribute("title", SOURCE);
    expect(screen.getByRole("button", { name: "Install from URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  });

  it("hides the controls when the deployment has no skill-source routes", async () => {
    state.sourcesAvailable = false;
    show();
    await waitFor(() => expect(state.calls.some((c) => c.path.endsWith("/installed"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Install from URL" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });

  it("discovers a source, preselects new skills, and installs the selection", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Install from URL" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Source URL"), `${SOURCE}/`);
    await user.click(within(dialog).getByRole("button", { name: "Find skills" }));

    expect(await within(dialog).findByText("Write release notes")).toBeInTheDocument();
    expect(within(dialog).getByText("installed")).toBeInTheDocument();
    // New skills are preselected; installed ones are left for an explicit reinstall.
    expect(within(dialog).getByRole("checkbox", { name: "release-notes" })).toHaveAttribute("data-state", "checked");
    expect(within(dialog).getByRole("checkbox", { name: "code-review" })).toHaveAttribute("data-state", "unchecked");

    await user.click(within(dialog).getByRole("button", { name: "Install 1" }));
    expect(await within(dialog).findByText("Installed")).toBeInTheDocument();
    expect(state.calls.find((c) => c.path.endsWith("/install"))?.body).toEqual({
      url: SOURCE,
      skills: ["release-notes"],
    });
  });

  it("shows why a source could not be read", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Install from URL" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Source URL"), "https://bad.example");
    await user.click(within(dialog).getByRole("button", { name: "Find skills" }));
    expect(await within(dialog).findByText(/No Agent Skills index found/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeDisabled();
  });

  it("checks for updates and updates a skill to the source's latest version", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Check for updates" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Update available")).toBeInTheDocument();
    expect(within(dialog).getByText(/1 more skill available from skills.example.com\/team: triage/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Update all (1)" }));
    expect(await within(dialog).findByText("Updated")).toBeInTheDocument();
    expect(await within(dialog).findByText("Up to date")).toBeInTheDocument();
    expect(state.calls.find((c) => c.path.endsWith("/update"))?.body).toEqual({ skill_ids: ["skill_review"] });
  });
});
