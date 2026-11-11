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
    .runCmd("apt-get update -qq && apt-get install -y -qq python3 ca-certificates curl unzip fuse3 && rm -rf /var/lib/apt/lists/* && useradd --create-home oma-worker && mkdir -p /opt/oma-managed/worker /workspace /run/oma-managed && chown oma-worker:oma-worker /workspace && chmod 700 /opt/oma-managed /run/oma-managed")
    // Same release and checksum as scripts/install-ci-rclone.sh. Bookworm's
    // packaged rclone predates the Unix RC/VFS queue protocol used by drain.
    .runCmd([
      "set -eu",
      'test "$(dpkg --print-architecture)" = amd64',
      'archive=$(mktemp -d)',
      `trap 'rm -rf "$archive"' EXIT`,
      'curl --fail --location --retry 3 --output "$archive/rclone.zip" https://downloads.rclone.org/v1.74.1/rclone-v1.74.1-linux-amd64.zip',
      `printf '%s  %s\\n' 67df3059a6233b6e32e604bcd637654bb294ff86291b65ede77123e94818d911 "$archive/rclone.zip" | sha256sum --check -`,
      'unzip -q "$archive/rclone.zip" -d "$archive"',
      'install -m 0755 "$archive/rclone-v1.74.1-linux-amd64/rclone" /usr/local/bin/rclone',
      "rclone version | grep -Fx 'rclone v1.74.1'",
      "fusermount3 --version",
    ].join("\n"))
    .copy("agent-exec.py", "/opt/oma-managed/agent-exec.py", { mode: 0o600 })
    .copy("agent-spawner.mjs", "/opt/oma-managed/agent-spawner.mjs", { mode: 0o600 })
    .copy("launcher.py", "/opt/oma-managed/launcher.py", { mode: 0o600 })
    .copy("verify-install.py", "/opt/oma-managed/verify-install.py", { mode: 0o600 })
    .copy("installation.json", "/opt/oma-managed/installation.json", { mode: 0o600 })
    .copy("worker/", "/opt/oma-managed/worker/")
    // The base template carries no ACP agent. A Session's pinned registry
    // agent is installed by the Environment setup step and reused from the
    // prepared environment snapshot, so adding or bumping an ACP never
    // rebuilds this template.
    .runCmd("chown -R root:root /opt/oma-managed && chmod -R go-w /opt/oma-managed && " + verify)
    .setStartCmd(verify + " && exec /usr/bin/python3 -I -S /opt/oma-managed/launcher.py", sdk.waitForFile("/run/oma-managed/ready"));
}
