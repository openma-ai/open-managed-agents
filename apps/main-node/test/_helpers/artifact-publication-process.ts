// Test-only crash barrier around a real disk read. Production assembly, SQL,
// blob persistence and publication remain unchanged; the parent sends SIGKILL.
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";

const directory = process.env.ARTIFACT_TEST_BARRIER_DIR;
if (!directory || process.env.NODE_ENV !== "test") throw new Error("Artifact fixture requires an isolated test directory");
const arm = join(directory, "publication-crash-arm");
const read = LocalSubprocessSandbox.prototype.readFileBytes;
let reads = 0;
LocalSubprocessSandbox.prototype.readFileBytes = async function(path) {
  if (path.startsWith("/workspace/outputs/") && existsSync(arm) && ++reads === 2) {
    await unlink(arm);
    await writeFile(join(directory!, "publication-crash-ready"), path);
    await new Promise<void>(() => {});
  }
  return read.call(this, path);
};
await import("../../src/index");
