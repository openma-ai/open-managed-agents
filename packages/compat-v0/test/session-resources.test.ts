import { describe, expect, it } from "vitest";
import { createApp } from "@open-managed-agents/app";
import { sessionResourceStorePort } from "@open-managed-agents/app/modules/session-resources";
import {
  sessionResourceStoreFromV0,
  sessionResourcesDependenciesFromV0,
  v0SessionResourcePersistenceModule,
} from "../src/session-resources";

describe("v0 Session Resource compatibility", () => {
  it("renames the structurally compatible Port without wrapping storage", () => {
    const persistence = {
      findCurrent: async () => null,
      replaceCurrent: async () => ({ type: "not_found" as const }),
    };
    expect(sessionResourceStoreFromV0(persistence)).toBe(persistence);

    const dependencies = sessionResourcesDependenciesFromV0({
      workspaceId: "workspace_01",
      persistence,
      files: {} as never,
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: { nextResourceId: () => "sesrsc_01" },
    });
    expect("persistence" in dependencies).toBe(false);
    expect(dependencies.store).toBe(persistence);

    const app = createApp({
      modules: [v0SessionResourcePersistenceModule(persistence)],
    });
    expect(app.port(sessionResourceStorePort)).toBe(persistence);
  });
});
