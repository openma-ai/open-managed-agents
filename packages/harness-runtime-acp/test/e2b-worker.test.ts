import { expect, it } from "vitest";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertE2BInstalledHarness, createE2BStateIo, loadE2BAgentSpawner } from "../src/node-e2b-work-item";

it("performs state writes, reads and shell operations only through the isolated boundary", async () => {
 const root = await mkdtemp(join(process.cwd(), ".test-state-"));
 const commands: string[] = [];
 const native = new NodeSpawner();
 const io = createE2BStateIo({ spawn: async spec => { commands.push(spec.command); return native.spawn({...spec, command: process.execPath}); } }, root);
 try {
  await io.writeFile("/workspace/nested/state", "literal state");
  expect(await io.readFile("/workspace/nested/state")).toBe("literal state");
  await io.writeFileBytes("/workspace/bytes", new Uint8Array([0,255]));
  expect(await io.exec("printf isolated-shell")).toBe("isolated-shell");
  await expect(io.readFile("/workspace/absent")).rejects.toMatchObject({code: "ENOENT"});
  expect(commands).toEqual(Array(5).fill("/usr/local/bin/node"));
 } finally { await rm(root,{recursive:true,force:true}); }
});

it("rejects runtime package installation or untrusted harness inventory in the root worker", () => {
 expect(() => assertE2BInstalledHarness({})).toThrow(/preinstalled/);
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_HARNESSES: JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/workspace/agent"}])})).toThrow(/preinstalled/);
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_SOURCES:"{}"})).toThrow(/preinstalled/);
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_HARNESSES: JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/opt/oma-harnesses/codex-acp/bin/codex-acp"}])})).not.toThrow();
});

it("fails closed if the root-private isolation module cannot load", async () => {
 let requested = "";
 await expect(loadE2BAgentSpawner(async path => { requested = path; throw new Error("missing isolation helper"); })).rejects.toThrow("missing isolation helper");
 expect(requested).toBe("file:///opt/oma-managed/agent-spawner.mjs");
});
it("rejects a module without the isolation export rather than using NodeSpawner", async () => {
 await expect(loadE2BAgentSpawner(async () => ({}))).rejects.toThrow(/isolateE2BAgentSpawner/);
});
it("uses only the isolated spawner at the actual process launch boundary", async () => {
 const isolated = await loadE2BAgentSpawner(async () => ({ isolateE2BAgentSpawner: () => ({ spawn: async (spec: {env?:Record<string,string|undefined>}) => { expect(spec.env).toMatchObject({PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/home/oma-worker"}); throw new Error("isolated-launch-boundary"); } }) }));
 await expect(isolated.spawn({ command: "/must-not-run", args: [], env: {} })).rejects.toThrow("isolated-launch-boundary");
});

const codex = { id: "codex-acp", version: "1.8.0", command: "/opt/oma-harnesses/codex-acp/bin/codex-acp" };
const pi = { id: "pi-acp", version: "0.1.8", command: "/opt/oma-harnesses/pi-acp/bin/openma-pi-acp" };
it.each([[pi], [codex, pi], [pi, codex]])("accepts only template-certified installed entries: %j", (...entries) => {
 expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: JSON.stringify(entries) })).not.toThrow();
});
it.each([
 [], [pi, pi], [{ ...pi, version: "0.1.9" }], [{ ...pi, command: "/workspace/openma-pi-acp" }],
 [{ ...pi, args: ["--loader", "/workspace/hook.js"] }], [{ ...pi, id: "unknown" }], [pi, null],
])("rejects inventory outside the fixed installed closure: %j", (...entries) => {
 expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: JSON.stringify(entries) })).toThrow(/preinstalled/);
});
it("rejects runtime source/package overrides even with certified pi inventory", () => {
 for (const key of ["OPENMA_ACP_SOURCES", "OPENMA_ACP_PACKAGES"]) {
  expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: JSON.stringify([pi]), [key]: "[]" })).toThrow(/preinstalled/);
 }
});
it.each(["null", "{}", "not-json", "[null]", '[{"id":"pi-acp"}]'])("rejects malformed installed inventory %s", raw => {
 expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: raw })).toThrow(/preinstalled/);
});
