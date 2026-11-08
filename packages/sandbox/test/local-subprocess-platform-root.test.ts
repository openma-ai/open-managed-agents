import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSubprocessSandbox } from "../src/adapters/local-subprocess";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalSubprocessSandbox platform root", () => {
  it("keeps /oma inside the session workdir for commands, file tools and env", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "openma-local-oma-"));
    roots.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    await sandbox.setEnvVars({ AGENT_STATE: "/oma/harness-state/native" });

    await sandbox.exec("mkdir -p /oma/harness-state && printf cmd > /oma/harness-state/a.txt");
    await sandbox.writeFile("/oma/harness-state/b.txt", "tool");
    await sandbox.exec('mkdir -p "$AGENT_STATE" && printf env > "$AGENT_STATE/c.txt"');

    const host = join(workdir, ".mnt", "oma", "harness-state");
    await expect(readFile(join(host, "a.txt"), "utf8")).resolves.toBe("cmd");
    await expect(readFile(join(host, "native", "c.txt"), "utf8")).resolves.toBe("env");
    await expect(sandbox.readFile("/oma/harness-state/b.txt")).resolves.toBe("tool");
    // Whole path tokens only: /omakase is not the platform root.
    await expect(sandbox.exec("printf %s /omakase")).resolves.toBe("/omakase");
  });
});
