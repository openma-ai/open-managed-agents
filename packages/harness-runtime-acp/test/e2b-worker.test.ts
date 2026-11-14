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
 expect(() => assertE2BInstalledHarness({})).toThrow(/pinned ACP harness/);
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_HARNESSES: JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/workspace/agent"}])})).toThrow(/pinned ACP harness/);
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_SOURCES:"{}"})).toThrow(/pinned ACP harness/);
 // The base template bakes no ACP; legacy template paths are refused.
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_HARNESSES: JSON.stringify([{id:"codex-acp",version:"1.8.0",command:"/opt/oma-harnesses/codex-acp/bin/codex-acp"}])})).toThrow(/pinned ACP harness/);
});

it("accepts a pinned registry harness installed by the Environment setup step at its exact launcher only", () => {
 const inventory = (entry: object) => ({OPENMA_ACP_HARNESSES: JSON.stringify([entry])});
 expect(() => assertE2BInstalledHarness(inventory({id:"pi-acp",version:"0.1.8",command:"/home/oma-worker/.oma/installed-agent/pi-acp/0.1.8/acp-launch.sh"}))).not.toThrow();
 expect(() => assertE2BInstalledHarness(inventory({id:"claude-acp",version:"0.94.0",command:"/home/oma-worker/.oma/installed-agent/claude-acp/0.94.0/acp-launch.sh"}))).not.toThrow();
 for (const entry of [
  {id:"pi-acp",version:"0.1.9",command:"/home/oma-worker/.oma/installed-agent/pi-acp/0.1.9/acp-launch.sh"}, // not pinned
  {id:"pi-acp",version:"0.1.8",command:"/workspace/.oma/installed-agent/pi-acp/0.1.8/acp-launch.sh"}, // wrong root
  {id:"pi-acp",version:"0.1.8",command:"/home/oma-worker/.oma/installed-agent/codex-acp/1.8.0/acp-launch.sh"}, // another agent's launcher
  {id:"unknown-acp",version:"1.0.0",command:"/home/oma-worker/.oma/installed-agent/unknown-acp/1.0.0/acp-launch.sh"},
 ]) expect(() => assertE2BInstalledHarness(inventory(entry))).toThrow(/pinned ACP harness/);
 const pi = {id:"pi-acp",version:"0.1.8",command:"/home/oma-worker/.oma/installed-agent/pi-acp/0.1.8/acp-launch.sh"};
 expect(() => assertE2BInstalledHarness({OPENMA_ACP_HARNESSES: JSON.stringify([pi, pi])})).toThrow(/pinned ACP harness/);
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

const codex = { id: "codex-acp", version: "1.8.0", command: "/home/oma-worker/.oma/installed-agent/codex-acp/1.8.0/acp-launch.sh" };
const pi = { id: "pi-acp", version: "0.1.8", command: "/home/oma-worker/.oma/installed-agent/pi-acp/0.1.8/acp-launch.sh" };
it.each([[pi], [codex]])("accepts exactly one Environment-setup installed pinned entry: %j", (...entries) => {
 expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: JSON.stringify(entries) })).not.toThrow();
});
it.each([
 [], [pi, pi], [codex, pi], [{ ...pi, command: "/opt/oma-harnesses/pi-acp/bin/openma-pi-acp" }], [{ ...pi, version: "0.1.9" }], [{ ...pi, command: "/workspace/openma-pi-acp" }],
 [{ ...pi, args: ["--loader", "/workspace/hook.js"] }], [{ ...pi, id: "unknown" }], [pi, null],
])("rejects inventory outside the fixed installed closure: %j", (...entries) => {
 expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: JSON.stringify(entries) })).toThrow(/pinned ACP harness/);
});
it("rejects runtime source/package overrides even with certified pi inventory", () => {
 for (const key of ["OPENMA_ACP_SOURCES", "OPENMA_ACP_PACKAGES"]) {
  expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: JSON.stringify([pi]), [key]: "[]" })).toThrow(/pinned ACP harness/);
 }
});
it.each(["null", "{}", "not-json", "[null]", '[{"id":"pi-acp"}]'])("rejects malformed installed inventory %s", raw => {
 expect(() => assertE2BInstalledHarness({ OPENMA_ACP_HARNESSES: raw })).toThrow(/pinned ACP harness/);
});
