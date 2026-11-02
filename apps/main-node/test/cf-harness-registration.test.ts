import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { transform } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { parse } = createRequire(import.meta.resolve("vitest"))("acorn");

beforeEach(() => vi.resetModules());

// Exercise the actual registration statements (including registrations inside
// test bodies) against one real registry. Do not import the CF/HTTP/DO graph in
// Node: that belongs to the separate workerd integration run.
async function initializeFrom(relativePath: string, ids?: string[]) {
  const source = await readFile(new URL(`../../../test/${relativePath}`, import.meta.url), "utf8");
  const { code } = await transform(source, { loader: "ts", target: "esnext" });
  const file = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const statements: string[] = [];
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ClassDeclaration" && node.id?.name.endsWith("Harness")) {
      statements.push(code.slice(node.start, node.end));
      return;
    }
    if (node.type === "ExpressionStatement" && node.expression.type === "CallExpression" &&
      ["registerHarness", "registerCoreHarnesses", "registerTestHarnesses"].includes(node.expression.callee.name)) {
      if (!ids || node.expression.callee.name !== "registerHarness" || ids.includes(node.expression.arguments[0]?.value)) {
        statements.push(code.slice(node.start, node.end));
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(file);
  const { registerHarness } = await import("@open-managed-agents/agent/harness/registry");
  const { registerCoreHarnesses } = await import("@open-managed-agents/agent/harness/builtins");
  let registerTestHarnesses: (() => void) | undefined;
  if (statements.some((statement) => statement.startsWith("registerTestHarnesses("))) {
    const modulePath = new URL("../../../test/harnesses.ts", import.meta.url).pathname;
    ({ registerTestHarnesses } = await import(/* @vite-ignore */ modulePath));
  }
  new Function("registerHarness", "registerCoreHarnesses", "registerTestHarnesses", statements.join("\n"))(
    registerHarness, registerCoreHarnesses, registerTestHarnesses,
  );
}

const callers = [
  "integration/session-harness.test.ts",
  "integration/api.test.ts",
  "integration/research.test.ts",
  "integration/parity.test.ts",
  "integration/cross-resource.test.ts",
  "integration/trajectory-route.test.ts",
  "integration/error-edge-cases.test.ts",
  "integration/files.test.ts",
  "integration/features.test.ts",
  "integration/evals-route.test.ts",
  "integration/recovery-do.test.ts",
  "integration/stress.test.ts",
  "integration/long-idle-recovery.test.ts",
  "integration/schedule-wakeup.test.ts",
];

describe("CF test harness registration composition", () => {
  it.each(callers)("initializes the worker and %s in the same registry", async (caller) => {
    await initializeFrom("test-worker.ts");
    await expect(initializeFrom(caller)).resolves.toBeUndefined();
  });

  it("also initializes when tests load before the worker", async () => {
    await initializeFrom("integration/session-harness.test.ts");
    await expect(initializeFrom("test-worker.ts")).resolves.toBeUndefined();
    await expect(initializeFrom("integration/session-harness.test.ts")).resolves.toBeUndefined();
  });

  it("does not hide a conflicting pre-existing test harness", async () => {
    const { registerHarness, resolveHarness } = await import("@open-managed-agents/agent/harness/registry");
    const existing = { async run() {} };
    registerHarness("multi-msg", () => existing);
    await expect(initializeFrom("test-worker.ts")).rejects.toThrow(/already registered.*multi-msg/);
    expect(resolveHarness("multi-msg")).toBe(existing);
  });

  it("allows repeated unit-test noop initialization", async () => {
    await initializeFrom("test-worker.ts");
    await expect(initializeFrom("unit/unit.test.ts", ["noop"])).resolves.toBeUndefined();
    await expect(initializeFrom("unit/unit.test.ts", ["noop"])).resolves.toBeUndefined();
  });

  it("preserves the features fixed reply separately from the worker echo", async () => {
    await initializeFrom("test-worker.ts");
    await initializeFrom("integration/features.test.ts");
    const { resolveHarness } = await import("@open-managed-agents/agent/harness/registry");
    for (const [id, text] of [["echo-test", "echo: hello"], ["features-echo-test", "echo reply"]]) {
      const events: unknown[] = [];
      await resolveHarness(id).run({ userMessage: { content: [{ type: "text", text: "hello" }] },
        runtime: { broadcast: (event: unknown) => events.push(event) } } as never);
      expect(events).toEqual([{ type: "agent.message", content: [{ type: "text", text }] }]);
    }
  });

  it("keeps multi-message behavior and rejects direct duplicate registration", async () => {
    await initializeFrom("test-worker.ts");
    await initializeFrom("integration/session-harness.test.ts");
    const { resolveHarness, registerHarness } = await import("@open-managed-agents/agent/harness/registry");
    const events: unknown[] = [];
    await resolveHarness("multi-msg").run({ runtime: { broadcast: (event: unknown) => events.push(event) } } as never);
    expect(events).toEqual(["msg1", "msg2", "msg3"].map((text) => ({
      type: "agent.message", content: [{ type: "text", text }],
    })));
    expect(() => registerHarness("multi-msg", () => ({ async run() {} }))).toThrow(/already registered/);
  });
});
