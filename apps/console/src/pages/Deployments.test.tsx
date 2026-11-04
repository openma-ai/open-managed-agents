import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { DeploymentDetail } from "./DeploymentDetail";
import { DeploymentNew } from "./DeploymentNew";
import { SessionsList } from "./SessionsList";
import { EnvironmentsList } from "./EnvironmentsList";
import { DeploymentsList } from "./DeploymentsList";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "user_1", name: "Ada", email: "ada@example.com" } }),
}));

const agent = { id: "agent_1", name: "Triage bot" };
const environment = { id: "env_1", name: "prod" };

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "depl_1",
    type: "deployment",
    name: "Nightly triage",
    description: null,
    agent: { id: "agent_1", type: "agent", version: 2 },
    environment_id: "env_1",
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "Triage the inbox" }] }],
    metadata: { created_by: "ada@example.com" },
    paused_reason: null,
    resources: [],
    schedule: null,
    status: "active",
    vault_ids: [],
    budget: null,
    archived_at: null,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

const page = <T,>(data: T[]) => HttpResponse.json({ data, next_page: null });

/** Lists the pickers read. Individual tests add deployment handlers. */
function mockCatalog() {
  server.use(
    http.get("*/v1/agents", () => page([agent])),
    http.get("*/v1/agents/agent_1", () => HttpResponse.json(agent)),
    http.get("*/v1/environments", () => page([environment])),
    http.get("*/v1/environments/env_1", () => HttpResponse.json(environment)),
    http.get("*/v1/vaults", () => page([{ id: "vlt_1", display_name: "Team keys" }])),
    http.get("*/v1/files", () =>
      HttpResponse.json({ data: [], has_more: false, first_id: null, last_id: null }),
    ),
    http.get("*/v1/memory_stores", () => page([])),
  );
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: "/deployments", element: <DeploymentsList /> },
      { path: "/deployments/new", element: <DeploymentNew /> },
      { path: "/deployments/:id", element: <DeploymentDetail /> },
      { path: "/sessions", element: <SessionsList /> },
      { path: "/environments", element: <EnvironmentsList /> },
      { path: "/sessions/:id", element: <p>Session page</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeAll(() => {
  // cmdk pickers measure and scroll their lists; jsdom has neither API.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("oma-locale", "en");
  mockCatalog();
});

afterEach(() => vi.restoreAllMocks());

describe("DeploymentsList", () => {
  it("shows the heading, filters and one row per deployment", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get("*/v1/deployments", ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return page([
          deployment(),
          deployment({
            id: "depl_2",
            name: "Weekday digest",
            schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/Chicago" },
            metadata: { created_by: "lin@example.com" },
          }),
        ]);
      }),
    );
    renderAt("/deployments");

    expect(screen.getByRole("heading", { level: 1, name: "Deployments" })).toBeInTheDocument();
    expect(screen.getByText(/binds an agent to credentials, an environment, and a schedule/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create deployment" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search by name or exact ID")).toBeInTheDocument();

    const row = await screen.findByRole("row", { name: /Weekday digest/ });
    expect(within(row).getByText("depl_2")).toBeInTheDocument();
    expect(within(row).getByText("0 9 * * 1-5")).toBeInTheDocument();
    expect(within(row).getByText("lin@example.com")).toBeInTheDocument();
    expect(await within(screen.getByRole("row", { name: /Nightly triage/ })).findByText("Triage bot")).toBeInTheDocument();
    expect(within(screen.getByRole("row", { name: /Nightly triage/ })).getByText("Manual")).toBeInTheDocument();
    for (const column of ["ID", "Name", "Agent", "Trigger", "Created by", "Created"]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeInTheDocument();
    }
    // Status defaults to Active, and archived deployments are never requested.
    expect(queries[0]?.get("status")).toBe("active");
    expect(queries[0]?.has("include_archived")).toBe(false);
    expect(screen.getByRole("button", { name: /Status\s*:\s*Active/ })).toBeInTheDocument();
  });

  it("searches by name or exact ID and filters by creator", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/deployments", () =>
        page([
          deployment(),
          deployment({ id: "depl_2", name: "Weekday digest", metadata: { created_by: "lin@example.com" } }),
        ]),
      ),
    );
    renderAt("/deployments");
    await screen.findByRole("row", { name: /Weekday digest/ });

    const search = screen.getByPlaceholderText("Search by name or exact ID");
    await user.type(search, "digest");
    expect(screen.queryByRole("row", { name: /Nightly triage/ })).toBeNull();
    expect(screen.getByRole("row", { name: /Weekday digest/ })).toBeInTheDocument();

    // A partial ID is not an ID match.
    await user.clear(search);
    await user.type(search, "depl_");
    expect(await screen.findByText("No matching deployments")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "depl_1");
    expect(screen.getByRole("row", { name: /Nightly triage/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /Weekday digest/ })).toBeNull();
    await user.clear(search);

    await user.click(screen.getByRole("button", { name: /Created by/ }));
    await user.click(await screen.findByRole("option", { name: "lin@example.com" }));
    expect(screen.queryByRole("row", { name: /Nightly triage/ })).toBeNull();
    expect(screen.getByRole("row", { name: /Weekday digest/ })).toBeInTheDocument();
  });

  it("drops the status filter for All", async () => {
    const user = userEvent.setup();
    const statuses: (string | null)[] = [];
    server.use(
      http.get("*/v1/deployments", ({ request }) => {
        statuses.push(new URL(request.url).searchParams.get("status"));
        return page([deployment({ status: "paused" })]);
      }),
    );
    renderAt("/deployments");
    await screen.findByRole("row", { name: /Nightly triage/ });
    await user.click(screen.getByRole("button", { name: /Status/ }));
    await user.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => expect(statuses.at(-1)).toBeNull());
    expect(statuses[0]).toBe("active");
  });

  it("searches subsequent pages when a match is not loaded yet", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/deployments", ({ request }) => {
      const cursor = new URL(request.url).searchParams.get("page");
      return cursor ? page([deployment({ id: "depl_later", name: "Later digest" })])
        : HttpResponse.json({ data: [deployment()], next_page: "next" });
    }));
    renderAt("/deployments");
    await screen.findByRole("row", { name: /Nightly triage/ });
    await user.type(screen.getByPlaceholderText("Search by name or exact ID"), "Later digest");
    expect(await screen.findByRole("row", { name: /Later digest/ })).toBeInTheDocument();
  });

  it("offers Create deployment from the empty state", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/deployments", () => page([])));
    const router = renderAt("/deployments");
    expect(await screen.findByText("No deployments")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "Create deployment" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    expect(router.state.location.pathname).toBe("/deployments/new");
  });

  it("runs, pauses and archives from the row actions", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(
      http.get("*/v1/deployments", () => page([deployment()])),
      http.post("*/v1/deployments/:id/:action", ({ params }) => {
        posts.push(`${params.id}/${params.action}`);
        return params.action === "run"
          ? HttpResponse.json({ id: "drun_1", type: "deployment_run" })
          : HttpResponse.json(deployment());
      }),
    );
    renderAt("/deployments");
    await screen.findByRole("row", { name: /Nightly triage/ });

    for (const action of ["Run now", "Pause", "Archive"]) {
      await user.click(screen.getByRole("button", { name: "Actions: Nightly triage" }));
      await user.click(await screen.findByRole("menuitem", { name: action }));
    }
    await waitFor(() => expect(posts).toEqual(["depl_1/run", "depl_1/pause", "depl_1/archive"]));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Nightly triage"));
  });
});

  async function fillGeneral(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Name"), "Nightly triage");
    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: /Triage bot/ }));
    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(await screen.findByRole("option", { name: /prod/ }));
    await user.type(screen.getByLabelText("Initial message"), "Triage the inbox");
  }

describe("DeploymentNew", () => {

  it("does not render an in-page breadcrumb on Create deployment", async () => {
    renderAt("/deployments/new");
    expect(screen.getByRole("heading", { level: 1, name: "Create deployment" })).toBeInTheDocument();
    // Crumbs live in AppShell only — a page-local <nav> / Deployments link is a regression.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Deployments" })).not.toBeInTheDocument();
  });

  it("shows General, Trigger and Resources with Manual selected", async () => {
    renderAt("/deployments/new");
    expect(screen.getByRole("heading", { level: 1, name: "Create deployment" })).toBeInTheDocument();
    for (const section of ["General", "Trigger", "Resources"]) {
      expect(screen.getByRole("region", { name: section })).toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("POST /v1/deployments/:id/run")).toBeInTheDocument();
  });

  it("requires the general fields before creating", async () => {
    const user = userEvent.setup();
    const create = vi.fn();
    server.use(http.post("*/v1/deployments", create));
    renderAt("/deployments/new");
    await user.click(screen.getByRole("button", { name: "Create deployment" }));
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Agent is required")).toBeInTheDocument();
    expect(screen.getByText("Environment is required")).toBeInTheDocument();
    expect(screen.getByText("Initial message is required")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a manual deployment stamped with its creator", async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      http.post("*/v1/deployments", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(deployment(), { status: 201 });
      }),
      http.get("*/v1/deployments/depl_1", () => HttpResponse.json(deployment())),
      http.get("*/v1/deployment_runs", () => page([])),
    );
    const router = renderAt("/deployments/new");
    await fillGeneral(user);
    await user.type(screen.getByLabelText(/Budget/), "12.50");

    await user.click(screen.getByRole("button", { name: /Add vault/ }));
    await user.click(await screen.findByRole("option", { name: /Team keys/ }));
    expect(screen.getByRole("button", { name: "Remove vault Team keys" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Add resource/ }));
    await user.click(await screen.findByRole("menuitem", { name: /GitHub repository/ }));
    await user.type(screen.getByLabelText("URL"), "https://github.com/acme/app");
    await user.type(screen.getByLabelText("Authorization token"), "ghp_secret");

    await user.click(screen.getByRole("button", { name: "Create deployment" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/deployments/depl_1"));
    expect(body).toEqual({
      name: "Nightly triage",
      agent: "agent_1",
      environment_id: "env_1",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "Triage the inbox" }] }],
      budget: { type: "limit", max_list_cost: { amount: "1250", currency: "USD" } },
      vault_ids: ["vlt_1"],
      resources: [
        { type: "github_repository", url: "https://github.com/acme/app", authorization_token: "ghp_secret" },
      ],
      metadata: { created_by: "ada@example.com" },
    });
  });

  it("sends file and read-only memory resources with their options", async () => {
    const user = userEvent.setup();
    let body: { resources?: unknown } = {};
    server.use(
      http.get("*/v1/files", () => HttpResponse.json({
        data: [{ id: "file_1", filename: "input.csv" }], has_more: false,
      })),
      http.get("*/v1/memory_stores", () => page([{ id: "ms_1", name: "Team notes" }])),
      http.post("*/v1/deployments", async ({ request }) => {
        body = await request.json() as typeof body;
        return HttpResponse.json(deployment(), { status: 201 });
      }),
      http.get("*/v1/deployments/depl_1", () => HttpResponse.json(deployment())),
      http.get("*/v1/deployment_runs", () => page([])),
    );
    renderAt("/deployments/new");
    await fillGeneral(user);
    await user.click(screen.getByRole("button", { name: /Add resource/ }));
    await user.click(await screen.findByRole("menuitem", { name: "File" }));
    await user.click(screen.getByRole("tab", { name: "File ID" }));
    await user.type(screen.getByLabelText("File ID"), "file_1");
    await user.type(screen.getByLabelText(/Mount path/), "/workspace/input.csv");
    await user.click(screen.getByRole("button", { name: /Add resource/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Memory store" }));
    await user.click(screen.getByRole("combobox", { name: "Select a memory store" }));
    await user.click(await screen.findByRole("option", { name: /Team notes/ }));
    await user.click(screen.getByRole("combobox", { name: "Access" }));
    await user.click(await screen.findByRole("option", { name: "Read only" }));
    await user.type(screen.getByLabelText(/Instructions/), "Read team conventions first.");
    await user.click(screen.getByRole("button", { name: "Create deployment" }));
    await waitFor(() => expect(body.resources).toEqual([
      { type: "file", file_id: "file_1", mount_path: "/workspace/input.csv" },
      { type: "memory_store", memory_store_id: "ms_1", access: "read_only", instructions: "Read team conventions first." },
    ]));
  });

  it("previews a schedule and sends its cron expression", async () => {
    const user = userEvent.setup();
    let body: { schedule?: unknown } = {};
    server.use(
      http.post("*/v1/deployments", async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(deployment(), { status: 201 });
      }),
      http.get("*/v1/deployments/depl_1", () => HttpResponse.json(deployment())),
      http.get("*/v1/deployment_runs", () => page([])),
    );
    renderAt("/deployments/new");
    await fillGeneral(user);

    await user.click(screen.getByRole("tab", { name: "Schedule" }));
    expect(screen.getByTestId("cron-preview")).toHaveTextContent("0 9 * * 1-5");
    expect(within(screen.getByRole("list", { name: "Next 5 runs" })).getAllByRole("listitem")).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "PM" }));
    expect(screen.getByTestId("cron-preview")).toHaveTextContent("0 21 * * 1-5");

    await user.click(screen.getByRole("button", { name: "Edit cron" }));
    const cron = screen.getByLabelText("Cron expression");
    expect(cron).toHaveValue("0 21 * * 1-5");
    await user.clear(cron);
    await user.type(cron, "61 * * * *");
    await user.click(screen.getByRole("button", { name: "Create deployment" }));
    expect(screen.getByText(/Invalid cron expression/)).toBeInTheDocument();

    await user.clear(cron);
    await user.type(cron, "*/30 * * * *");
    await user.click(screen.getByRole("button", { name: "Create deployment" }));
    await waitFor(() =>
      expect(body.schedule).toEqual({
        type: "cron",
        expression: "*/30 * * * *",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
  });

  it("localizes schedule controls and validation in Chinese", async () => {
    localStorage.setItem("oma-locale", "zh-CN");
    const user = userEvent.setup();
    renderAt("/deployments/new");
    await user.click(screen.getByRole("tab", { name: "定时" }));
    expect(screen.getByRole("button", { name: "上午" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑 cron" }));
    await user.clear(screen.getByLabelText("Cron 表达式"));
    await user.type(screen.getByLabelText("Cron 表达式"), "61 * * * *");
    await user.click(screen.getByRole("button", { name: "创建部署" }));
    expect(screen.getByText(/Cron 表达式无效/)).toBeInTheDocument();
  });

  it("asks before leaving with unsaved changes", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/deployments", () => page([])));
    const router = renderAt("/deployments/new");

    // A pristine form leaves without asking.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(router.state.location.pathname).toBe("/deployments");
    await router.navigate("/deployments/new");

    await user.type(await screen.findByLabelText("Name"), "Draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(within(dialog).getByText("If you leave this page, your changes will be lost.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe("/deployments/new");
    expect(screen.getByLabelText("Name")).toHaveValue("Draft");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/deployments"));
  });
});

describe("DeploymentDetail", () => {
  it("shows properties and runs, and runs, pauses and archives", async () => {
    const user = userEvent.setup();
    let current = deployment({
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
        last_run_at: null,
        upcoming_runs_at: ["2026-11-05T09:00:00.000Z"],
      },
      vault_ids: ["vlt_1"],
      budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } },
    });
    const runs = [
      {
        id: "drun_ok",
        type: "deployment_run",
        deployment_id: "depl_1",
        agent: { id: "agent_1", type: "agent", version: 2 },
        created_at: "2026-11-02T09:00:00.000Z",
        error: null,
        session_id: "sesn_1",
        trigger_context: { type: "schedule", scheduled_at: "2026-11-02T09:00:00.000Z" },
      },
      {
        id: "drun_bad",
        type: "deployment_run",
        deployment_id: "depl_1",
        agent: { id: "agent_1", type: "agent", version: 2 },
        created_at: "2026-11-01T12:00:00.000Z",
        error: { type: "environment_archived_error", message: "Environment env_1 is archived" },
        session_id: null,
        trigger_context: { type: "manual" },
      },
    ];
    const posts: string[] = [];
    const runQueries: (string | null)[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(
      http.get("*/v1/deployments/depl_1", () => HttpResponse.json(current)),
      http.get("*/v1/deployment_runs", ({ request }) => {
        runQueries.push(new URL(request.url).searchParams.get("deployment_id"));
        return page(runs);
      }),
      http.post("*/v1/deployments/depl_1/:action", ({ params }) => {
        posts.push(String(params.action));
        if (params.action === "run") return HttpResponse.json(runs[0]);
        current = params.action === "unpause"
          ? deployment({ ...current, status: "active", paused_reason: null })
          : params.action === "pause"
            ? deployment({ ...current, status: "paused", paused_reason: { type: "manual" } })
            : deployment({ ...current, archived_at: "2026-11-03T00:00:00.000Z" });
        return HttpResponse.json(current);
      }),
    );
    renderAt("/deployments/depl_1");

    expect(await screen.findByRole("heading", { level: 1, name: "Nightly triage" })).toBeInTheDocument();
    const properties = screen.getByRole("region", { name: "Properties" });
    expect(within(properties).getByRole("link", { name: "agent_1" })).toHaveAttribute("href", "/agents/agent_1");
    expect(within(properties).getByText("version 2")).toBeInTheDocument();
    expect(within(properties).getByText("Triage the inbox")).toBeInTheDocument();
    expect(within(properties).getByText("$5.00")).toBeInTheDocument();
    expect(within(properties).getByRole("link", { name: "vlt_1" })).toBeInTheDocument();
    expect(within(properties).getByText("ada@example.com")).toBeInTheDocument();

    const runsTable = await screen.findByRole("table", { name: "Runs" });
    expect(within(runsTable).getByRole("link", { name: "Session started" })).toHaveAttribute("href", "/sessions/sesn_1");
    expect(within(runsTable).getByText(/Failed: Environment env_1 is archived/)).toBeInTheDocument();
    expect(runQueries[0]).toBe("depl_1");

    // Run now refreshes the runs list once the run is created.
    const runFetches = runQueries.length;
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runQueries.length).toBeGreaterThan(runFetches));

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByText(/Paused manually/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("This deployment is archived and no longer runs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(posts).toEqual(["run", "pause", "unpause", "archive"]);
  });

  it("offers retry after a failed detail request", async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get("*/v1/deployments/depl_1", () => fail
        ? HttpResponse.json({ error: { type: "api_error", message: "Unavailable" } }, { status: 503 })
        : HttpResponse.json(deployment())),
      http.get("*/v1/deployment_runs", () => page([])),
    );
    renderAt("/deployments/depl_1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load deployments");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Nightly triage" })).toBeInTheDocument();
  });

  it("reports a missing deployment", async () => {
    server.use(
      http.get("*/v1/deployments/depl_gone", () =>
        HttpResponse.json(
          { type: "error", error: { type: "not_found_error", message: "Deployment depl_gone was not found" } },
          { status: 404 },
        ),
      ),
      http.get("*/v1/deployment_runs", () => page([])),
    );
    renderAt("/deployments/depl_gone");
    expect(await screen.findByText("Deployment not found.")).toBeInTheDocument();
  });
});


describe("strict #448 acceptance", () => {
  it("uploads a file inline as multipart and submits its returned ID", async () => {
    const user = userEvent.setup();
    let uploaded = "";
    const append = vi.spyOn(FormData.prototype, "append");
    let body: {resources?: unknown} = {};
    server.use(
      http.post("*/v1/files", async ({request}) => {
        expect(request.headers.get("content-type")).toContain("multipart/form-data");
        uploaded = await request.text();
        return HttpResponse.json({id: "file_uploaded", filename: "brief.txt"});
      }),
      http.post("*/v1/deployments", async ({request}) => { body = await request.json() as typeof body; return HttpResponse.json(deployment()); }),
      http.get("*/v1/deployments/depl_1", () => HttpResponse.json(deployment())),
      http.get("*/v1/deployment_runs", () => page([])),
    );
    renderAt("/deployments/new");
    await fillGeneral(user);
    await user.click(screen.getByRole("button", {name: "Add resource"}));
    await user.click(await screen.findByRole("menuitem", {name: "File"}));
    expect(screen.getByText("Drop a file here")).toBeVisible();
    await user.upload(screen.getByLabelText("Choose a file"), new File(["hello"], "brief.txt", {type: "text/plain"}));
    await screen.findByText("brief.txt");
    // jsdom File and Node fetch use different Blob realms. Assert the UI
    // passes the original file; the capture script checks multipart bytes in Chromium.
    expect(uploaded).toContain('name="file"');
    expect(append).toHaveBeenCalledWith("file", expect.objectContaining({name: "brief.txt"}));
    await user.click(screen.getByRole("button", {name: "Create deployment"}));
    await waitFor(() => expect(body.resources).toEqual([{type: "file", file_id: "file_uploaded"}]));
  });

  it("keeps the file draft on upload failure and allows retry", async () => {
    const user = userEvent.setup();
    server.use(http.post("*/v1/files", () => HttpResponse.json({error: {message: "failed"}}, {status: 500})));
    renderAt("/deployments/new");
    await user.click(screen.getByRole("button", {name: "Add resource"}));
    await user.click(await screen.findByRole("menuitem", {name: "File"}));
    await user.upload(screen.getByLabelText("Choose a file"), new File(["hello"], "brief.txt"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to upload file. Try again.");
    expect(screen.getByLabelText("Choose a file")).toBeEnabled();
  });

  it("preserves the search field and exact empty copy in empty pickers", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/agents", () => page([])), http.get("*/v1/vaults", () => page([])));
    renderAt("/deployments/new");
    await user.click(screen.getByLabelText("Agent"));
    expect(await screen.findByText("No agents yet.")).toBeVisible();
    expect(screen.getByPlaceholderText("Search agents by name or exact ID")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", {name: "Add vault"}));
    expect(await screen.findByText("None in this workspace yet.")).toBeVisible();
    expect(screen.getByPlaceholderText("Search vaults by name or exact ID")).toBeVisible();
  });

  it("shows active Sessions empty copy, then includes archived sessions when showing all", async () => {
    const user = userEvent.setup();
    const queries: URLSearchParams[] = [];
    server.use(http.get("*/v1/sessions", ({request}) => { queries.push(new URL(request.url).searchParams); return page([]); }), http.get("*/v1/deployments", () => page([])));
    renderAt("/sessions");
    expect(await screen.findByText("No active sessions")).toBeVisible();
    expect(screen.getByText("New sessions will appear here. Archived and terminated sessions are hidden from this view.")).toBeVisible();
    await user.click(screen.getByRole("button", {name: "Deployment All"}));
    expect(await screen.findByText("No deployments yet.")).toBeVisible();
    expect(screen.getByPlaceholderText("Search by name or exact ID")).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", {name: "Show all sessions"}));
    await waitFor(() => expect(queries.some(q => q.get("include_archived") === "true")).toBe(true));
  });

  it("sends deployment_id through the existing Sessions endpoint", async () => {
    const user = userEvent.setup();
    const queries: URLSearchParams[] = [];
    server.use(http.get("*/v1/sessions", ({request}) => { queries.push(new URL(request.url).searchParams); return page([]); }), http.get("*/v1/deployments", () => page([deployment()])));
    renderAt("/sessions");
    await screen.findByText("No active sessions");
    await user.click(screen.getByRole("button", {name: "Deployment All"}));
    await user.click(await screen.findByRole("option", {name: /Nightly triage/}));
    await waitFor(() => expect(queries.some(q => q.get("deployment_id") === "depl_1")).toBe(true));
  });

  it("shows all Sessions skeleton columns while the list is pending", async () => {
    server.use(http.get("*/v1/sessions", () => new Promise(() => {})), http.get("*/v1/deployments", () => page([])));
    renderAt("/sessions");
    for (const name of ["ID", "Name", "Status", "Agent", "Cost", "Tokens in / out", "Created by", "Created"]) {
      expect(screen.getByRole("columnheader", {name})).toBeVisible();
    }
    expect(document.querySelectorAll(".console-data-row-skeleton")).toHaveLength(10);
  });

  it("renders Environment scope, updated and archived columns from the API", async () => {
    server.use(http.get("*/v1/environments", () => page([{...environment, config: {type: "cloud"}, scope: "organization", updated_at: "2026-10-29T12:00:00Z", created_at: "2026-10-28T12:00:00Z", archived_at: null}])));
    renderAt("/environments");
    expect(await screen.findByRole("cell", {name: "Organization"})).toBeVisible();
    for (const name of ["ID", "Name", "Type", "Scope", "Updated at", "Archived at"]) expect(screen.getByRole("columnheader", {name})).toBeVisible();
    expect(screen.queryByRole("columnheader", {name: "Status"})).not.toBeInTheDocument();
  });
});
