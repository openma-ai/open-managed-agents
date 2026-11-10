/** Explicit opt-in: builds ONLY a new oma-v2e2b-* template and sandbox.
 * Run from template/: node --import <workspace tsx> ../test/managed-bootstrap.cloud.mts
 * E2B_SDK_MODULE must point to the installed, inspected e2b 2.63.0 module.
 * Credentials are inherited from the preauthorized oma-v2e2b config, never printed.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { managedTemplate } from "../template/template.mjs";
import { E2BSandboxExecutor } from "../src/e2b.ts";
import assert from "node:assert/strict";
const sdk = await import(process.env.E2B_SDK_MODULE!);
if (process.env.OMA_E2B_MANAGED_CLOUD !== "1" || !process.env.E2B_API_KEY) throw Error("Explicit cloud opt-in and authorized credentials required");
const alias = "oma-v2e2b-bootstrap-" + Date.now();
const startedAt = new Date().toISOString();
const launcherSha256 = createHash("sha256").update(await readFile("launcher.py")).digest("hex");
let sandbox;
try {
  const build = await sdk.Template.build(managedTemplate(sdk), alias, { apiKey: process.env.E2B_API_KEY, cpuCount: 1, memoryMB: 512 });
  console.log(JSON.stringify({ phase: "template-built", cloud: true, alias, build, launcherSha256, startedAt }));
  sandbox = await sdk.Sandbox.create(alias, { apiKey: process.env.E2B_API_KEY, timeoutMs: 120_000, metadata: { owner: alias, purpose: "545-managed-bootstrap" } });
  const adapter = new E2BSandboxExecutor(sandbox, { managedBootstrap: {} });
  await adapter.setEnvVars({ NODE_OPTIONS: "--require=/nonexistent/poison.cjs", SESSION_SECRET: "not-worker" });
  // Mutate the envd/image shell environment after the launcher is prestarted.
  await sandbox.files.write("/etc/profile.d/oma-poison.sh", "export BASH_ENV=/workspace/poison.sh\nexport ENV=/workspace/poison.sh\nexport NODE_OPTIONS=--require=/nonexistent/poison.cjs\nexport IMAGE_SECRET=not-worker\n", { user: "root" });
  await sandbox.files.write("/workspace/poison.sh", "touch /workspace/poison-executed\n", { user: "root" });
  const argv = ["literal'quote", "$(touch /workspace/argv-executed)", "line\nbreak"];
  const handle = await adapter.startManagedProcess({ command: "/usr/local/bin/node", cwd: "/workspace", env: { ONLY: "yes" }, args: ["-e", "require('fs').writeFileSync('/workspace/observed.json',JSON.stringify({env:process.env,args:process.argv.slice(1),cwd:process.cwd(),uid:process.getuid()}))", ...argv] });
  for (let n = 0; n < 100 && await handle.getStatus() !== "exited"; n++) await new Promise(r => setTimeout(r, 25));
  assert.equal(await handle.getStatus(), "exited");
  const observed = JSON.parse(await sandbox.files.read("/workspace/observed.json", { user: "root" }));
  assert.deepEqual(observed.env, { ONLY: "yes" }); assert.deepEqual(observed.args, argv); assert.equal(observed.cwd, "/workspace"); assert.equal(observed.uid, 0);
  // Ordinary agent exec is oma-worker; management remains root.
  await assert.rejects(sandbox.files.read("/run/oma-managed/ready", { user: "oma-worker" }));
  for (const file of ["/workspace/poison-executed", "/workspace/argv-executed"]) {
    await assert.rejects(sandbox.files.read(file, { user: "root" }), (e: any) => ["FileNotFoundError", "NotFoundError"].includes(e.name));
  }
  const live = await adapter.startManagedProcess({ command: "/usr/local/bin/node", args: ["-e", "setInterval(()=>{},1000)"], env: {} });
  assert.equal(await live.getStatus(), "running"); await live.kill("SIGKILL");
  for (let n = 0; n < 100 && await live.getStatus() !== "exited"; n++) await new Promise(r => setTimeout(r, 25));
  assert.equal(await live.getStatus(), "exited");
  console.log(JSON.stringify({ phase: "native-management", result: "PASS", cloud: true, alias, sandboxId: sandbox.sandboxId, launcherSha256, observed, statusKill: "PASS" }));
} finally {
  if (sandbox) { await sandbox.kill(); console.log(JSON.stringify({ phase: "sandbox-cleanup", sandboxId: sandbox.sandboxId, result: "PASS" })); }
  // Template remains explicitly identified; never delete any pre-existing resource.
  console.log(JSON.stringify({ phase: "template-retained", alias }));
}
