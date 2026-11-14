import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalSubprocessSandbox } from "../src/adapters/local-subprocess";

it("defers a relay allocation error to the relay caller and still destroys a sandbox that never uses egress", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "oma-relay-error-"));
  try {
    await writeFile(join(workdir, ".oma-relay-port"), "invalid");
    const sandbox = new LocalSubprocessSandbox({ workdir });
    // No relay consumer yet: acquisition failure must not become an unhandled rejection.
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(sandbox.egressRelayPort()).rejects.toThrow("Invalid persisted sandbox relay port");
    await expect(sandbox.destroy()).resolves.toBeUndefined();
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
