import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { EvalRunDetail } from "./EvalRunDetail";

vi.mock("../lib/api", () => ({ useApi: () => ({ api: vi.fn() }) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: {
      id: "eval-1",
      agent_id: "agent-1",
      environment_id: "env-1",
      status: "completed",
      started_at: "2026-08-31T10:00:00.000Z",
      ended_at: "2026-08-31T10:01:00.000Z",
      task_count: 1,
      completed_count: 1,
      failed_count: 0,
      tasks: [{
        id: "task-1",
        spec: { id: "task-1", messages: ["hello"] },
        status: "completed",
        trials: [],
        trial_pass_count: 0,
        trial_total: 0,
      }],
    },
    isLoading: false,
    error: null,
  }),
}));

describe("EvalRunDetail Linear surface", () => {
  it("uses the canonical detail inset and wireless result table", async () => {
    render(
      <MemoryRouter initialEntries={["/evals/eval-1"]}>
        <Routes>
          <Route path="/evals/:id" element={<EvalRunDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("detail-layout")).toHaveAttribute(
      "data-detail-layout",
      "single",
    );
    expect(screen.getByTestId("eval-results-table")).toHaveClass(
      "console-detail-table-wrap",
    );
  });
});
