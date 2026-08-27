import { describe, expect, it } from "vitest";
import {
  createV0MigrationRouter,
  planV0Migration,
} from "../src/index";

describe("createV0MigrationRouter", () => {
  it("cuts over only the exact selected workspaces and reports the active lane", () => {
    const plan = planV0Migration({
      domains: [{ name: "agents", strategy: "compat" }],
      rollout: {
        type: "workspaces",
        workspaceIds: ["workspace_01"],
      },
    });
    const router = createV0MigrationRouter({
      plan,
      v0: {
        app: ({ workspaceId }) => ({ source: "v0" as const, workspaceId }),
      },
      v1: {
        app: ({ workspaceId }) => ({ source: "v1" as const, workspaceId }),
      },
    });

    expect(router.resolve({ workspaceId: "workspace_01" })).toEqual({
      lane: "v1",
      app: { source: "v1", workspaceId: "workspace_01" },
    });
    expect(router.resolve({ workspaceId: "workspace_010" })).toEqual({
      lane: "v0",
      app: { source: "v0", workspaceId: "workspace_010" },
    });
    expect(router.app({ workspaceId: "workspace_02" })).toEqual({
      source: "v0",
      workspaceId: "workspace_02",
    });
  });

  it("refuses to route from an invalid plan or an empty tenant key", () => {
    const invalidPlan = planV0Migration({
      domains: [{ name: "not-extracted", strategy: "native" }],
      rollout: { type: "all" },
    });
    const source = { app: ({ workspaceId }: { workspaceId: string }) => workspaceId };

    expect(() => createV0MigrationRouter({
      plan: invalidPlan,
      v0: source,
      v1: source,
    })).toThrowError(/valid migration plan/u);

    const router = createV0MigrationRouter({
      plan: planV0Migration({
        domains: [{ name: "agents", strategy: "native" }],
        rollout: { type: "all" },
      }),
      v0: source,
      v1: source,
    });
    expect(() => router.app({ workspaceId: "  " })).toThrowError(
      /workspaceId must not be empty/u,
    );
  });
});
