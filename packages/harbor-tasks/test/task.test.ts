import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHarborSizeToMb, UnsupportedHarborTaskError } from "../src/task";
import { loadHarborTask } from "../src/node";

async function taskDir(toml: string, extra: (dir: string) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "harbor-task-"));
  await writeFile(join(dir, "task.toml"), toml);
  await writeFile(join(dir, "instruction.md"), "Do the thing.\n");
  await mkdir(join(dir, "tests"));
  await writeFile(join(dir, "tests", "test.sh"), "#!/bin/bash\n");
  await extra(dir);
  return dir;
}

const BASE = `version = "1.0"
[verifier]
timeout_sec = 900.0
[agent]
timeout_sec = 1200.0
[environment]
docker_image = "alexgshaw/fix-git:20251031"
cpus = 1
memory = "2G"
`;

describe("loadHarborTask", () => {
  it("resolves the terminal-bench task shape", async () => {
    const dir = await taskDir(BASE, async (d) => {
      await mkdir(join(d, "solution"));
      await writeFile(join(d, "solution", "solve.sh"), "#!/bin/bash\n");
    });
    const task = await loadHarborTask(dir, "fix-git");
    expect(task).toMatchObject({
      name: "fix-git",
      instruction: "Do the thing.\n",
      image: "alexgshaw/fix-git:20251031",
      agentTimeoutSec: 1200,
      verifierTimeoutSec: 900,
      cpus: 1,
      memoryMb: 2048,
      verifierEnv: {},
    });
    expect(task.solution?.map((file) => file.path)).toEqual(["solve.sh"]);
    expect(task.tests.map((file) => file.path)).toEqual(["test.sh"]);
  });

  it("uses Harbor defaults and tolerates a missing solution", async () => {
    const task = await loadHarborTask(await taskDir(`[environment]\ndocker_image = "img:1"\n`));
    expect(task.verifierTimeoutSec).toBe(600);
    expect(task.agentTimeoutSec).toBeNull();
    expect(task.memoryMb).toBeNull();
    expect(task.solution).toBeNull();
  });

  it.each([
    ["no prebuilt image", `[environment]\ncpus = 1\n`, /docker_image/],
    ["internet disabled (legacy field)", `[environment]\ndocker_image = "i:1"\nallow_internet = false\n`, /allow_internet/],
    ["no_network mode", `[environment]\ndocker_image = "i:1"\nnetwork_mode = "no_network"\n`, /network_mode/],
    ["verifier allowlist", `[environment]\ndocker_image = "i:1"\n[verifier]\nnetwork_mode = "allowlist"\n`, /verifier.network_mode/],
    ["multi-step tasks", `[environment]\ndocker_image = "i:1"\n[[steps]]\nname = "a"\n`, /multi-step/],
    ["windows", `[environment]\ndocker_image = "i:1"\nos = "windows"\n`, /os=windows/],
    ["GPUs", `[environment]\ndocker_image = "i:1"\ngpus = 1\n`, /GPU/],
  ])("rejects %s explicitly", async (_label, toml, message) => {
    await expect(loadHarborTask(await taskDir(toml))).rejects.toThrow(message);
  });

  it("rejects docker-compose environments", async () => {
    const dir = await taskDir(BASE, async (d) => {
      await mkdir(join(d, "environment"));
      await writeFile(join(d, "environment", "docker-compose.yaml"), "services: {}\n");
    });
    await expect(loadHarborTask(dir)).rejects.toBeInstanceOf(UnsupportedHarborTaskError);
  });

  it("rejects conflicting memory fields", async () => {
    await expect(loadHarborTask(await taskDir(`[environment]\ndocker_image = "i:1"\nmemory = "2G"\nmemory_mb = 1024\n`)))
      .rejects.toThrow(/conflicting/);
  });
});

describe("parseHarborSizeToMb", () => {
  it("matches Harbor's conversion", () => {
    expect(parseHarborSizeToMb("2G")).toBe(2048);
    expect(parseHarborSizeToMb("1.5g")).toBe(1536);
    expect(parseHarborSizeToMb("512M")).toBe(512);
    expect(parseHarborSizeToMb("2048K")).toBe(2);
    expect(() => parseHarborSizeToMb("2GB")).toThrow(/Invalid size/);
  });
});
