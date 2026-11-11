import { expect, it } from "vitest";
import { workCheckpointExecutor } from "../../../packages/control-plane-node/src/lib/work-finalization-host/workspace.js";

const recorder = (provider?: string) => {
  const calls: string[] = [];
  const sandbox = {
    ...(provider ? { runtimeHandle: () => ({ provider, runtimeId: "rt" }) } : {}),
    exec: async (command: string) => { calls.push("exec " + command); return ""; },
    readFile: async (path: string) => { calls.push("read " + path); return ""; },
    writeFile: async (path: string) => { calls.push("write " + path); return ""; },
    readFileBytes: async (path: string) => { calls.push("readBytes " + path); return new Uint8Array(); },
  };
  return { calls, sandbox: sandbox as never };
};

it("E2B transfers checkpoint archives through its own /var/tmp, never the LocalSubprocess /oma root", async () => {
  const r = recorder("e2b");
  const executor = workCheckpointExecutor(r.sandbox);
  await executor.exec("tar -C /workspace -czf /var/tmp/openma-workspace-x.tgz .");
  await executor.readFileBytes!("/var/tmp/openma-workspace-x.tgz");
  expect(r.calls).toEqual(["exec tar -C /workspace -czf /var/tmp/openma-workspace-x.tgz .", "readBytes /var/tmp/openma-workspace-x.tgz"]);
  expect(r.calls.join("\n")).not.toContain("/oma");
});

it("LocalSubprocess keeps the mapped /oma transfer root excluded from the archive", async () => {
  const r = recorder();
  const executor = workCheckpointExecutor(r.sandbox);
  await executor.exec("tar -C /workspace -czf /var/tmp/openma-workspace-x.tgz .");
  await executor.readFileBytes!("/var/tmp/openma-workspace-x.tgz");
  expect(r.calls[0]).toContain("mkdir -p /oma/checkpoint-transfer");
  expect(r.calls[0]).toContain("--exclude=./.mnt/oma/checkpoint-transfer");
  expect(r.calls[1]).toBe("readBytes /oma/checkpoint-transfer/openma-workspace-x.tgz");
});
