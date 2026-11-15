// Published SDK argv characterization, not a real cloud test.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const { Sandbox } = await import(process.env.E2B_SDK_MODULE!);
const root = await mkdtemp(join(process.cwd(), "test/.sdk-shell-"));
try {
  const marker = join(root, "executed"); const hook = join(root, "bash-env.sh");
  await writeFile(hook, "printf unsafe > " + JSON.stringify(marker));
  const sandbox = new Sandbox({ sandboxId: "characterization", envdVersion: "0.5.0", domain: "localhost", apiKey: "test" });
  let observed: any;
  // Capture only envd transport. All process construction is actual SDK code.
  sandbox.commands.rpc = { start(input: any) { observed = input.process; throw Error("captured"); } };
  try { await sandbox.commands.run("/usr/bin/env -i /bin/bash --noprofile --norc -c true", { envs: { PATH: "/usr/bin:/bin" } }); } catch {}
  assert.ok(observed);
  await promisify(execFile)(observed.cmd, observed.args, { env: { BASH_ENV: hook, ...observed.envs } });
  assert.equal(await readFile(marker, "utf8"), "unsafe");
  console.log(JSON.stringify({ sdk: "2.63.0", cloud: false, sdkShell: observed.cmd, argsPrefix: observed.args.slice(0, 2), hookExecutedBeforeEnvI: true, managementBootstrapSafe: false, legacySafetyResult: "FAIL (reproduced)" }));
} finally { await rm(root, { recursive: true, force: true }); }
// Captured RPC bypasses SDK transport cleanup and leaves its start timer alive.
process.exit(0);
