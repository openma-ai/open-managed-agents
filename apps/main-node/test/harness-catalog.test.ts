import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import * as harnesses from "@open-managed-agents/control-plane-node";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";

const first = { run: async () => {}, onSessionInit: async () => {} };
const second = { run: async () => {} };
const descriptor = {
  id: "catalog-custom-host",
  label: "Custom host",
  description: "Host loop with independently callable runtime",
  execution: { placement: "host" as const },
  capabilities: { runtime_binding: true },
  requirements: [],
};
let cp: NodeControlPlane | undefined;
let dir: string | undefined;
afterAll(async () => {
  await cp?.stop("test");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("deployment harness catalog", () => {
  it("rejects duplicate legacy registrations instead of replacing a factory", () => {
    harnesses.registerHarness("catalog-legacy", () => first);
    expect(() => harnesses.registerHarness("catalog-legacy", () => second)).toThrow(/already registered/i);
    expect(resolveHarness("catalog-legacy")).toBe(first);
  });

  it("registers two custom implementations without coupling placement to runtime binding", () => {
    harnesses.registerHarness(descriptor, () => first);
    harnesses.registerHarness({
      id: "catalog-custom-sandbox", label: "Custom sandbox", description: "Sandbox loop",
      execution: { placement: "sandbox" }, capabilities: { runtime_binding: false }, requirements: ["acp.agent.command"],
    }, () => second);
    expect(resolveHarness("catalog-custom-host")).toBe(first);
    expect(resolveHarness("catalog-custom-sandbox")).toBe(second);
    expect(resolveHarness("catalog-custom-host").onSessionInit).toBe(first.onSessionInit);
    expect(harnesses.getHarnessCatalog().data).toEqual(expect.arrayContaining([
      descriptor,
      { id: "catalog-custom-sandbox", label: "Custom sandbox", description: "Sandbox loop",
        execution: { placement: "sandbox" }, capabilities: { runtime_binding: false }, requirements: ["acp.agent.command"] },
      { id: "catalog-legacy", label: "catalog-legacy", description: "",
        execution: { placement: "unknown" }, capabilities: { runtime_binding: null }, requirements: [] },
    ]));
  });

  it("selects a registered default and preserves it across core initialization", () => {
    harnesses.setDefaultHarness("catalog-custom-host");
    registerCoreHarnesses();
    registerCoreHarnesses();
    expect(resolveHarness()).toBe(first);
    expect(resolveHarness("default")).toBe(first);
    expect(harnesses.getHarnessCatalog().object).toBe("list");
    expect(harnesses.getHarnessCatalog().default_harness_id).toBe("catalog-custom-host");
    expect(harnesses.getHarnessCatalog().data.some((entry) => entry.id === "default")).toBe(false);
    expect(() => harnesses.registerHarness(descriptor, () => second)).toThrow(/already registered/i);
  });

  it("rejects unknown selection/default targets and empty ids without changing the default", () => {
    expect(() => resolveHarness("catalog-missing")).toThrow(/Unknown harness/);
    expect(() => harnesses.setDefaultHarness("catalog-missing")).toThrow(/Unknown harness/);
    expect(() => harnesses.setDefaultHarness("default")).toThrow(/default.*alias/i);
    expect(() => harnesses.registerHarness(" ", () => first)).toThrow(/id/i);
    expect(resolveHarness()).toBe(first);
  });

  it("copies only public fields, never instantiates factories, and isolates catalog mutations", () => {
    let calls = 0;
    const registration = {
      id: "catalog-private", label: "Private", description: "Public description",
      execution: { placement: "host" as const, token: "execution-secret" },
      capabilities: { runtime_binding: true, token: "capability-secret" },
      requirements: ["acp.agent.command"],
      secret: "top-secret", factory: "not-public",
    };
    harnesses.registerHarness(registration, () => { calls++; return first; });
    registration.label = "mutated";
    registration.requirements.push("runtime_binding.runtime_id");
    const entry = harnesses.getHarnessCatalog().data.find((item) => item.id === "catalog-private")!;
    expect(entry).toEqual({ id: "catalog-private", label: "Private", description: "Public description",
      execution: { placement: "host" }, capabilities: { runtime_binding: true }, requirements: ["acp.agent.command"] });
    entry.execution.placement = "unknown";
    expect(harnesses.getHarnessCatalog().data.find((item) => item.id === "catalog-private")!.execution.placement).toBe("host");
    expect(calls).toBe(0);
    expect(JSON.stringify(harnesses.getHarnessCatalog())).not.toMatch(/secret|factory/);
  });

  it("serves the actual registry through existing control-plane authentication", async () => {
    const root = resolve(".test-artifacts");
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(join(root, "harness-catalog-"));
    const config = loadNodeConfig({
      NODE_ENV: "test", AUTH_DISABLED: "1", MEMORY_QUEUE: "disabled", API_KEY: "catalog-test-key",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      DATABASE_PATH: join(dir, "oma.db"), AUTH_DATABASE_PATH: join(dir, "auth.db"),
      SANDBOX_WORKDIR: join(dir, "sandboxes"), MEMORY_BLOB_DIR: join(dir, "memories"),
      FILES_BLOB_DIR: join(dir, "files"), SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    });
    cp = await createNodeControlPlane(await nodeDefaults(config, {
      auth: { description: "test", handler: () => new Response("not found", { status: 404 }),
        resolveSession: async () => null, findUser: async () => null },
    }));
    const url = "http://cp/v1/oma/harnesses";
    expect((await cp.fetch(new Request(url))).status).toBe(401);
    const response = await cp.fetch(new Request(url, { headers: { "x-api-key": "catalog-test-key" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(harnesses.getHarnessCatalog());
  });
});
