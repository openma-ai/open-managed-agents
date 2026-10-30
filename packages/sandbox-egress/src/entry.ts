import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { startLocalRelay, type LocalRelayConfig } from "./local-relay.js";
const directory = process.argv[2];
if (!directory) throw new Error("Sandbox relay directory required");
const config = () => JSON.parse(readFileSync(join(directory, "binding.json"), "utf8")) as LocalRelayConfig;
void (async () => {
  const relay = await startLocalRelay(config);
  writeFileSync(join(directory, "ca-bundle.crt"), [...rootCertificates, relay.certificatePem].join("\n"));
  writeFileSync(join(directory, "ready.json"), JSON.stringify({ pid: process.pid, port: relay.port, caFile: join(directory, "ca.crt"), caBundleFile: join(directory, "ca-bundle.crt") }));
  const close = async () => { try { unlinkSync(join(directory, "ready.json")); } catch {} await relay.close(); process.exit(0); };
  process.on("SIGTERM", () => { void close(); }); process.on("SIGINT", () => { void close(); });
  // A session-scoped orphan cannot live forever if the controller disappears.
  const expiry = setInterval(() => {
    try { const payload = config().pass.split(".")[0]!; if (JSON.parse(Buffer.from(payload, "base64url").toString()).expiresAt < Date.now()) void close(); }
    catch { void close(); }
  }, 30000);
  expiry.unref();
})().catch(() => { process.stderr.write("Sandbox credential relay failed\n"); process.exit(1); });
