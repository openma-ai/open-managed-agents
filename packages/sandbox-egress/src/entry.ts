import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { createRelayBindingHolder, relayAuthorization } from "./relay-binding.js";
import { checkRelayCredential, probeRelayToken } from "./relay-credential-watch.js";
import { RELAY_PROTOCOL } from "./relay-protocol.js";
import { startLocalRelay } from "./local-relay.js";
import { sendDirectHttps } from "./direct-https.js";
const directory = process.argv[2];
if (!directory) throw new Error("Sandbox relay directory required");
const readyFile = join(directory, "ready.json");
let exiting = false;
let published: Record<string, unknown> | null = null;
/** ready.json is non-secret: pid, port, protocol, CA paths, consumed deliveryId, last binding error. */
const publish = (fields: Record<string, unknown>) => {
  published = { ...published, ...fields };
  writeFileSync(`${readyFile}.next`, JSON.stringify(published)); renameSync(`${readyFile}.next`, readyFile);
};
const holder = createRelayBindingHolder(directory, (state) => { if (published !== null) publish({ bindingId: state.deliveryId, bindingError: state.error }); });
holder.consume();
// No binding delivered and none in memory: never run (a relay without a token
// would only fail requests, and must not become a direct-egress path).
if (holder.peek() === null) {
  process.stderr.write(`Sandbox credential relay has no binding${holder.state().error ? ` (${holder.state().error})` : ""}\n`);
  process.exit(1);
}
void (async () => {
  const relay = await startLocalRelay(() => holder.current(), { exiting: () => exiting });
  writeFileSync(join(directory, "ca-bundle.crt"), [...rootCertificates, relay.certificatePem].join("\n"));
  publish({ pid: process.pid, port: relay.port, protocol: RELAY_PROTOCOL, caFile: join(directory, "ca.crt"), caBundleFile: join(directory, "ca-bundle.crt"), bindingId: holder.state().deliveryId, bindingError: holder.state().error });
  const close = async () => {
    exiting = true; holder.freeze(); // /health answers 503; a pending delivery stays for the next relay
    try { if (JSON.parse(readFileSync(readyFile, "utf8")).pid === process.pid) unlinkSync(readyFile); } catch {}
    await relay.close(); process.exit(0);
  };
  process.on("SIGTERM", () => { void close(); }); process.on("SIGINT", () => { void close(); });
  // A token replaced without a restart: poll (works on every filesystem; the
  // relay also consumes before every gateway call).
  setInterval(() => holder.consume(), 200).unref();
  // An orphan whose controller disappeared exits once its execution ends:
  // the gateway then answers 401 for its token.
  setInterval(() => {
    void checkRelayCredential({
      read: () => holder.current(),
      probe: (binding) => probeRelayToken(binding, (request) => sendDirectHttps(request, binding.ca), relayAuthorization(binding)),
      exit: close,
    });
  }, 30000).unref();
})().catch(() => { process.stderr.write("Sandbox credential relay failed\n"); process.exit(1); });
