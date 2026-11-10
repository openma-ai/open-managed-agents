// Run from this directory. Uses only the public e2b 2.63.0 Template API.
// Trusted build-time shell only; no runtime launch ever uses Commands.run.
export function managedTemplate(sdk) {
  return sdk.Template().fromImage("node:24.18.0-bookworm-slim")
    .setUser("root")
    .runCmd("apt-get update -qq && apt-get install -y -qq python3 && rm -rf /var/lib/apt/lists/* && useradd --create-home oma-worker && mkdir -p /opt/oma-managed /workspace /run/oma-managed && chown oma-worker:oma-worker /workspace && chmod 700 /opt/oma-managed /run/oma-managed")
    .copy("agent-exec.py", "/opt/oma-managed/agent-exec.py", { mode: 0o600 })
    .copy("agent-spawner.mjs", "/opt/oma-managed/agent-spawner.mjs", { mode: 0o600 })
    .copy("launcher.py", "/opt/oma-managed/launcher.py", { mode: 0o600 })
    .setStartCmd("/usr/bin/python3 -I -S /opt/oma-managed/launcher.py", sdk.waitForFile("/run/oma-managed/ready"));
}
