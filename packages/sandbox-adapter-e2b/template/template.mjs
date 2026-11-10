// Uses public e2b 2.63.0 Template API; prepared context comes from prepare-context.mjs.
import { sourcePin } from "./source-pin.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function managedTemplate(sdk, preparedContext, expectedPin) {
  if (!preparedContext) throw new Error("Explicit prepared worker context required");
  const pin = sourcePin(expectedPin?.sourceSha, expectedPin?.lockSha256);
  const manifest = JSON.parse(readFileSync(join(preparedContext, "installation.json"), "utf8"));
  if (manifest.sourceSha !== pin.sourceSha || manifest.sourceLockSha256 !== pin.lockSha256) throw Error("Prepared context source pin mismatch");
  const verify = "/usr/bin/python3 -I -S /opt/oma-managed/verify-install.py --source-sha " + pin.sourceSha + " --lock-sha256 " + pin.lockSha256;
  return sdk.Template({ fileContextPath: preparedContext }).fromImage("node:24.18.0-bookworm-slim")
    .setUser("root")
    .runCmd("apt-get update -qq && apt-get install -y -qq python3 ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --create-home oma-worker && mkdir -p /opt/oma-managed/worker /opt/oma-harnesses/codex-acp /workspace /run/oma-managed && chown oma-worker:oma-worker /workspace && chmod 700 /opt/oma-managed /run/oma-managed")
    .copy("agent-exec.py", "/opt/oma-managed/agent-exec.py", { mode: 0o600 })
    .copy("agent-spawner.mjs", "/opt/oma-managed/agent-spawner.mjs", { mode: 0o600 })
    .copy("launcher.py", "/opt/oma-managed/launcher.py", { mode: 0o600 })
    .copy("verify-install.py", "/opt/oma-managed/verify-install.py", { mode: 0o600 })
    .copy("installation.json", "/opt/oma-managed/installation.json", { mode: 0o600 })
    .copy("worker/", "/opt/oma-managed/worker/")
    .copy("harness/", "/opt/oma-harnesses/codex-acp/")
    .runCmd("cd /opt/oma-harnesses/codex-acp && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p bin && ln -s ../node_modules/.bin/codex-acp bin/codex-acp && chown -R root:root /opt/oma-managed /opt/oma-harnesses && chmod -R go-w /opt/oma-managed /opt/oma-harnesses && " + verify)
    .setStartCmd(verify + " && exec /usr/bin/python3 -I -S /opt/oma-managed/launcher.py", sdk.waitForFile("/run/oma-managed/ready"));
}
