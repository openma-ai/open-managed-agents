import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  detachedProcessOptions,
  killProcessTree,
} from "./helpers/process-tree";

describe.runIf(process.platform !== "win32")("test process-tree cleanup", () => {
  it("waits for the actual owner pipes to close after the launcher exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oma-owner-drain-"));
    const worker = String.raw`
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.watch(${JSON.stringify(directory)}, (_event, name) => {
        if (name === "release") process.exit(0);
      });
      process.stdout.write("ready\n");
    `;
    const launcher = spawn(process.execPath, ["-e", `
      require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "inherit" });
      setInterval(() => {}, 1000);
    `], { ...detachedProcessOptions, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(launcher.stdout!, "data");
      const exited = once(launcher, "exit");
      let completed = false;
      const cleanup = killProcessTree(launcher, "SIGTERM").then(() => { completed = true; });
      await exited;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toBe(false);
      await writeFile(join(directory, "release"), "finish");
      await cleanup;
      expect(completed).toBe(true);
    } finally {
      await killProcessTree(launcher);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills a detached launcher and its inherited grandchild", async () => {
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        String.raw`
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "ignore",
          });
          process.stdout.write(String(child.pid) + "\n");
          setInterval(() => {}, 1000);
        `,
      ],
      {
        ...detachedProcessOptions,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      launcher.once("error", reject);
      launcher.stdout!.once("data", (data: Buffer) => {
        resolve(Number.parseInt(data.toString(), 10));
      });
    });

    await killProcessTree(launcher);

    await expect.poll(() => processExists(grandchildPid), {
      timeout: 500,
    }).toBe(false);
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
