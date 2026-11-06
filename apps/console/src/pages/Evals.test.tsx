import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvalBenchmark, EvalRun, MessagesEvalCase } from "@open-managed-agents/api-types";
import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { EvalRunDetail } from "./EvalRunDetail";
import { EvalRunsList } from "./EvalRunsList";
import { EvalBenchmarkDetail } from "./EvalBenchmarkDetail";
import { EvalBenchmarksList } from "./EvalBenchmarksList";
import { EvalCaseDetail } from "./EvalCaseDetail";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";

const harborBench: EvalBenchmark = {
  id: "evb_1",
  name: "hello-bench",
  kind: "harbor",
  source: { type: "builtin", name: "hello-bench" },
  case_count: 2,
  runnable_count: 1,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  cases: [
    {
      kind: "harbor",
      name: "hello-world",
      image: "ghcr.io/harbor/hello:1",
      image_alias: "harbor-hello",
      supported: true,
      agent_timeout_sec: 600,
      verifier_timeout_sec: 120,
      cpus: 1,
      memory_mb: 2048,
      has_solution: true,
      instruction_preview: "Write hello.txt",
      updated_at: "2026-11-01T10:00:00.000Z",
    },
    {
      kind: "harbor",
      name: "needs-gpu",
      image: "ghcr.io/harbor/gpu:1",
      image_alias: null,
      supported: false,
      unsupported_reason: "gpus are not supported",
      agent_timeout_sec: null,
      verifier_timeout_sec: 60,
      cpus: null,
      memory_mb: null,
      has_solution: false,
      instruction_preview: "",
      updated_at: "2026-11-01T10:00:00.000Z",
    },
  ],
};

const greetCase: MessagesEvalCase = {
  kind: "messages",
  name: "greet",
  messages: ["say hi", "say bye"],
  reward: { type: "verifiable", scorer: "agentMessageContains", opts: { target: "hi" } },
  updated_at: "2026-11-01T10:00:00.000Z",
};

const messagesBench: EvalBenchmark = {
  id: "evb_m",
  name: "smoke",
  kind: "messages",
  source: null,
  case_count: 1,
  runnable_count: 1,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  cases: [greetCase],
};

const harborRun: EvalRun = {
  id: "evr_1",
  kind: "harbor",
  agent_id: "agent_1",
  environment_id: null,
  benchmark_id: "evb_1",
  mode: "agent",
  status: "running",
  created_at: "2026-11-01T10:00:00.000Z",
  started_at: "2026-11-01T10:00:05.000Z",
  task_count: 4,
  completed_count: 2,
  failed_count: 1,
  score: 0.756,
  concurrency: 4,
  tasks: [
    {
      id: "hello-world",
      status: "completed",
      trial_total: 1,
      trial_pass_count: 1,
      mean_reward: 1,
      image_alias: "harbor-hello",
      trials: [
        {
          trial_index: 0,
          status: "completed",
          phase: "done",
          session_id: "sesn_abc",
          started_at: "2026-11-01T10:00:05.000Z",
          ended_at: "2026-11-01T10:01:05.000Z",
          reward: 1,
          rewards: { reward: 1, style: 0.5 },
          agent_timed_out: true,
          test_exit_code: 0,
          verifier_output_tail: "PASSED test_hello",
        },
      ],
    },
  ],
};

const legacyRun: EvalRun = {
  id: "evr_old",
  kind: "messages",
  agent_id: "agent_1",
  environment_id: "env_1",
  status: "cancelled",
  created_at: "2026-10-01T10:00:00.000Z",
  task_count: 1,
  completed_count: 0,
  failed_count: 0,
  tasks: [],
};

function renderRoutes(routes: RouteObject[], path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("oma-locale", "en");
  server.use(
    http.get("*/v1/oma/evals/benchmarks", () => HttpResponse.json({
      data: [{ ...harborBench, cases: undefined }, { ...messagesBench, cases: undefined }],
    })),
    http.get("*/v1/oma/evals/benchmarks/evb_1", () => HttpResponse.json(harborBench)),
    http.get("*/v1/oma/evals/benchmarks/evb_m", () => HttpResponse.json(messagesBench)),
    http.get("*/v1/environments", () => HttpResponse.json({ data: [{ id: "env_1", name: "sandbox" }], next_page: null })),
    http.get("*/v1/agents", () => HttpResponse.json({
      data: [
        { id: "agent_1", name: "Coder" },
        { id: "agent_oracle", name: "OMA eval oracle", metadata: { oma_eval_role: "oracle" } },
      ],
      next_page: null,
    })),
    http.get("*/v1/agents/agent_1", () => HttpResponse.json({ id: "agent_1", name: "Coder" })),
  );
});

describe("EvalRunsList", () => {
  it("renders harbor and legacy runs with benchmark, mode, progress and score", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get("*/v1/oma/evals/runs", ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json({ data: [harborRun, legacyRun] });
      }),
    );
    renderRoutes([{ path: "/evals", element: <EvalRunsList /> }], "/evals");

    const benchLink = await screen.findByRole("link", { name: "hello-bench" });
    expect(benchLink).toHaveAttribute("href", "/evals/benchmarks/evb_1");
    const row = benchLink.closest("tr")!;
    expect(within(row).getByText("harbor")).toBeInTheDocument();
    expect(within(row).getByText("Agent")).toBeInTheDocument();
    expect(within(row).getByText("Running")).toBeInTheDocument();
    expect(within(row).getByText("0.76")).toBeInTheDocument();
    expect(row).toHaveTextContent("3/4");
    expect(within(row).getByText("Coder")).toBeInTheDocument();

    const legacyRow = screen.getByText("evr_old").closest("tr")!;
    expect(within(legacyRow).getByText("messages")).toBeInTheDocument();
    expect(within(legacyRow).getByText("Cancelled")).toBeInTheDocument();

    expect(queries[0].get("limit")).toBe("100");
    expect(queries[0].get("benchmark_id")).toBeNull();
  });

  it("filters by ?benchmark=", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get("*/v1/oma/evals/runs", ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json({ data: [harborRun] });
      }),
    );
    renderRoutes([{ path: "/evals", element: <EvalRunsList /> }], "/evals?benchmark=evb_1");
    await screen.findByRole("link", { name: "hello-bench" });
    expect(queries.at(-1)!.get("benchmark_id")).toBe("evb_1");
  });
});

describe("EvalRunDetail (harbor)", () => {
  it("shows the header and expands a task into its trials", async () => {
    server.use(http.get("*/v1/oma/evals/runs/evr_1", () => HttpResponse.json(harborRun)));
    renderRoutes([{ path: "/evals/:id", element: <EvalRunDetail /> }], "/evals/evr_1");

    expect(await screen.findByText("0.76")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "hello-bench" })).toHaveAttribute("href", "/evals/benchmarks/evb_1");
    expect(screen.getByRole("button", { name: /Cancel run/ })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("eval-task-hello-world"));
    const trial = screen.getByTestId("eval-trial-0");
    expect(within(trial).getByText("done")).toBeInTheDocument();
    expect(within(trial).getByText("agent timed out")).toBeInTheDocument();
    expect(within(trial).getByText("style=0.5")).toBeInTheDocument();
    expect(within(trial).getByRole("link", { name: "sesn_abc" })).toHaveAttribute("href", "/sessions/sesn_abc");
    expect(screen.getByText(/Verifier output \(tail\)/)).toBeInTheDocument();
    expect(screen.getByText("PASSED test_hello")).toBeInTheDocument();
  });

  it("cancels an active run", async () => {
    let cancelled = false;
    server.use(
      http.get("*/v1/oma/evals/runs/evr_1", () =>
        HttpResponse.json(cancelled ? { ...harborRun, status: "cancelled" } : harborRun)),
      http.post("*/v1/oma/evals/runs/evr_1/cancel", () => {
        cancelled = true;
        return HttpResponse.json({ ...harborRun, status: "cancelled" });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderRoutes([{ path: "/evals/:id", element: <EvalRunDetail /> }], "/evals/evr_1");

    await userEvent.click(await screen.findByRole("button", { name: /Cancel run/ }));
    await waitFor(() => expect(cancelled).toBe(true));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });
});

describe("EvalBenchmarksList", () => {
  it("lists benchmarks and creates a messages benchmark", async () => {
    let body: unknown;
    server.use(
      http.post("*/v1/oma/evals/benchmarks", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...messagesBench, id: "evb_new", name: "fresh", case_count: 0, cases: [] }, { status: 201 });
      }),
      http.get("*/v1/oma/evals/benchmarks/evb_new", () =>
        HttpResponse.json({ ...messagesBench, id: "evb_new", name: "fresh", case_count: 0, cases: [] })),
    );
    const user = userEvent.setup();
    const router = renderRoutes(
      [
        { path: "/evals/benchmarks", element: <EvalBenchmarksList /> },
        { path: "/evals/benchmarks/:benchmarkId", element: <p>Benchmark page</p> },
      ],
      "/evals/benchmarks",
    );

    const row = (await screen.findByText("hello-bench")).closest("tr")!;
    expect(within(row).getByText("Harbor")).toBeInTheDocument();
    expect(screen.getByText("smoke").closest("tr")!).toHaveTextContent("Messages");

    await user.click(screen.getAllByRole("button", { name: /New benchmark/ })[0]!);
    await user.type(await screen.findByLabelText("Name"), "fresh");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/evals/benchmarks/evb_new"));
    expect(body).toEqual({ kind: "messages", name: "fresh" });
  });
});

describe("EvalBenchmarkDetail (harbor)", () => {
  it("lists cases, flags missing aliases, and replaces a case from an upload", async () => {
    let putBody: unknown;
    server.use(
      http.post("*/v1/files", () => HttpResponse.json({ id: "file_1", filename: "t.tar.gz" })),
      http.put("*/v1/oma/evals/benchmarks/evb_1/cases/hello-world", async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json(harborBench.cases![0]);
      }),
    );
    const user = userEvent.setup();
    renderRoutes([{ path: "/evals/benchmarks/:benchmarkId", element: <EvalBenchmarkDetail /> }], "/evals/benchmarks/evb_1");

    const gpu = await screen.findByTestId("eval-case-needs-gpu");
    expect(within(gpu).getByText("no SANDBOX_IMAGES alias")).toBeInTheDocument();
    expect(within(gpu).getByText("gpus are not supported")).toBeInTheDocument();
    const hello = screen.getByTestId("eval-case-hello-world");
    expect(within(hello).getByText("harbor-hello")).toBeInTheDocument();
    expect(hello).toHaveTextContent("600s / 120s");
    expect(screen.getByRole("link", { name: "View runs" })).toHaveAttribute("href", "/evals?benchmark=evb_1");

    await user.click(within(hello).getByRole("button", { name: "Replace hello-world" }));
    const file = new File([new Uint8Array([1, 2, 3])], "t.tar.gz", { type: "application/gzip" });
    await user.upload(await screen.findByLabelText("Archive (.tar / .tar.gz)"), file);
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(putBody).toEqual({ source: { type: "upload", file_id: "file_1" } }));
  });
});

describe("EvalBenchmarkDetail (messages)", () => {
  function renderMessages() {
    return renderRoutes(
      [
        { path: "/evals/benchmarks/:benchmarkId", element: <EvalBenchmarkDetail /> },
        { path: "/evals/benchmarks/:benchmarkId/cases/:caseName", element: <p>Case page</p> },
      ],
      "/evals/benchmarks/evb_m",
    );
  }

  it("adds a case from the form", async () => {
    let body: unknown;
    server.use(
      http.post("*/v1/oma/evals/benchmarks/evb_m/cases", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(messagesBench, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderMessages();

    const row = await screen.findByTestId("eval-case-greet");
    expect(row).toHaveTextContent("say hi");
    expect(row).toHaveTextContent("verifiable");

    await user.click(screen.getByRole("button", { name: "Add case" }));
    await user.type(await screen.findByLabelText("Case name"), "ask");
    await user.type(screen.getByLabelText("Message 1"), "what is 2+2?");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(body).toMatchObject({ name: "ask", messages: ["what is 2+2?"] }));
  });

  it("edits a case with PUT", async () => {
    let body: any;
    server.use(
      http.put("*/v1/oma/evals/benchmarks/evb_m/cases/greet", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(greetCase);
      }),
    );
    const user = userEvent.setup();
    renderMessages();

    await user.click(await screen.findByRole("button", { name: "Edit case greet" }));
    const second = await screen.findByLabelText("Message 2");
    await user.clear(second);
    await user.type(second, "say goodbye");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(body?.messages).toEqual(["say hi", "say goodbye"]));
    expect(body.reward).toMatchObject({ type: "verifiable", scorer: "agentMessageContains" });
  });

  it("deletes a case, and shows a 409 while a run is active", async () => {
    let deletes = 0;
    server.use(
      http.delete("*/v1/oma/evals/benchmarks/evb_m/cases/greet", () => {
        deletes++;
        return HttpResponse.json({ error: "Benchmark is used by active run evrun-x; cancel it first" }, { status: 409 });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderMessages();

    await user.click(await screen.findByRole("button", { name: "Delete greet" }));
    await waitFor(() => expect(deletes).toBe(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Conflict: .*active run evrun-x/);
  });
});

describe("EvalCaseDetail", () => {
  it("shows a harbor case's instruction and files", async () => {
    server.use(
      http.get("*/v1/oma/evals/benchmarks/evb_1/cases/hello-world", () =>
        HttpResponse.json({
          ...harborBench.cases![0],
          instruction: "Write hello.txt containing hi.",
          files: [
            { path: "task.toml", size: 120, executable: false },
            { path: "tests/test.sh", size: 2048, executable: true },
          ],
        })),
    );
    renderRoutes(
      [{ path: "/evals/benchmarks/:benchmarkId/cases/:caseName", element: <EvalCaseDetail /> }],
      "/evals/benchmarks/evb_1/cases/hello-world",
    );
    expect(await screen.findByTestId("eval-case-instruction")).toHaveTextContent("Write hello.txt containing hi.");
    const files = screen.getByTestId("eval-case-files");
    expect(files).toHaveTextContent("tests/test.sh");
    expect(files).toHaveTextContent("2.0 KB");
    expect(files).toHaveTextContent("executable");
  });
});

describe("NewEvalRunDialog", () => {
  function renderDialog(benchmarkId = "evb_1") {
    return renderRoutes(
      [
        { path: "/evals/new", element: <NewEvalRunDialog open onClose={() => {}} initialBenchmarkId={benchmarkId} /> },
        { path: "/evals/:id", element: <p>Run page</p> },
      ],
      "/evals/new",
    );
  }

  it("posts a harbor benchmark run with agent, case subset, trials and concurrency", async () => {
    let body: unknown;
    server.use(
      http.post("*/v1/oma/evals/runs", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ run_id: "evr_new", task_count: 1 });
      }),
    );
    const user = userEvent.setup();
    const router = renderDialog();

    const start = await screen.findByRole("button", { name: "Start run" });
    expect(start).toBeDisabled(); // agent mode without an agent

    await user.click(await screen.findByRole("combobox", { name: "Select an agent" }));
    expect(screen.queryByRole("option", { name: "OMA eval oracle" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Coder" }));

    const gpu = await screen.findByRole("checkbox", { name: /needs-gpu/ });
    expect(gpu).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /hello-world/ }));

    const trials = screen.getByLabelText("Trials per case (1–20)");
    await user.clear(trials);
    await user.type(trials, "3");
    const concurrency = screen.getByLabelText("Concurrency (1–32)");
    await user.clear(concurrency);
    await user.type(concurrency, "2");

    await user.click(start);
    await waitFor(() => expect(router.state.location.pathname).toBe("/evals/evr_new"));
    expect(body).toEqual({
      benchmark_id: "evb_1",
      mode: "agent",
      agent_id: "agent_1",
      case_names: ["hello-world"],
      trials: 3,
      concurrency: 2,
    });
  });

  it("shows the API error text when the run is rejected", async () => {
    server.use(
      http.post("*/v1/oma/evals/runs", () =>
        HttpResponse.json({ error: "benchmark has no runnable cases" }, { status: 400 })),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("combobox", { name: "Mode" }));
    await user.click(await screen.findByRole("option", { name: "Oracle" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("benchmark has no runnable cases");
  });

  it("runs a messages benchmark with an environment; oracle is disabled", async () => {
    let body: unknown;
    server.use(
      http.post("*/v1/oma/evals/runs", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ run_id: "evr_m", task_count: 1 });
      }),
    );
    const user = userEvent.setup();
    const router = renderDialog("evb_m");

    await user.click(await screen.findByRole("combobox", { name: "Mode" }));
    expect(await screen.findByRole("option", { name: "Oracle (harbor only)" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");

    await user.click(await screen.findByRole("combobox", { name: "Select an agent" }));
    await user.click(await screen.findByRole("option", { name: "Coder" }));
    const start = screen.getByRole("button", { name: "Start run" });
    expect(start).toBeDisabled(); // no environment yet
    await user.click(await screen.findByRole("combobox", { name: "Select an environment" }));
    await user.click(await screen.findByRole("option", { name: "sandbox" }));
    await user.click(await screen.findByRole("checkbox", { name: /greet/ }));

    await user.click(start);
    await waitFor(() => expect(router.state.location.pathname).toBe("/evals/evr_m"));
    expect(body).toEqual({
      benchmark_id: "evb_m",
      mode: "agent",
      agent_id: "agent_1",
      environment_id: "env_1",
      case_names: ["greet"],
      trials: 1,
      concurrency: 4,
    });
  });
});
