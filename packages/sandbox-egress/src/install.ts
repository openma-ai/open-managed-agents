import { readFile } from "node:fs/promises";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { supportsCredentialEgress } from "@open-managed-agents/sandbox";
import type { CredentialEgressRevokeReason, RuntimeResourceScope, RuntimeResourceFence } from "@open-managed-agents/runtime-resource-contract";
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const installed = new WeakMap<object, string[]>();
const lifecycles = new WeakSet<object>();
let bundle: Promise<string> | undefined;
async function relayBundle() {
  bundle ??= readFile(fileURLToPath(new NodeURL("../dist/relay.cjs", import.meta.url)), "utf8").catch(() => { throw new Error("Sandbox relay bundle missing; build @open-managed-agents/sandbox-egress before starting the host"); });
  return bundle;
}
type Preparation = Parameters<typeof prepareSandboxEgress>[0];
/** Fits ProviderManagedRuntimeOptions.credentialEgress for every SandboxPort.
 * The host supplies current Session grants and revokes authorization remotely;
 * this adapter owns only the sandbox-side process/environment lifecycle.
 * Environment proxies are advisory, not provider-enforced network policy. */
export function createSandboxCredentialEgress(options: {
  resolve(input: { scope: RuntimeResourceScope; fence: RuntimeResourceFence; signal: AbortSignal }): Promise<{
    vaultIds: readonly string[];
    relay: Preparation["relay"];
    issuePass: Preparation["issuePass"];
    placeholders: Preparation["placeholders"];
  }>;
  revoke(input: { scope: RuntimeResourceScope; fence: RuntimeResourceFence; reason: CredentialEgressRevokeReason }): Promise<void>;
}) {
  return {
    capabilities: { enforcement: "advisory" as const, credentialMode: "live" as const, interceptedProtocols: ["https" as const] },
    async attach(input: { runtime: SandboxPort; scope: RuntimeResourceScope; fence: RuntimeResourceFence; requirement: "required" | "best_effort"; signal: AbortSignal }) {
      input.signal.throwIfAborted();
      if (input.requirement === "required") throw new Error("Sandbox environment proxy is advisory; required egress needs provider-native enforcement");
      const grant = await options.resolve(input);
      input.signal.throwIfAborted();
      await prepareSandboxEgress({ ...grant, sandbox: input.runtime, scope: { ...input.scope, vaultIds: grant.vaultIds } });
      input.signal.throwIfAborted();
    },
    async revoke(input: { runtime: SandboxPort; scope: RuntimeResourceScope; fence: RuntimeResourceFence; reason: CredentialEgressRevokeReason }) {
      try { await options.revoke(input); }
      finally { await clearSandboxEgress(input.runtime); }
    },
  };
}
export interface PreparedSandboxEgress { pid?: number; port?: number; caFile?: string }
export async function clearSandboxEgress(sandbox: SandboxPort): Promise<void> {
  if (supportsCredentialEgress(sandbox)) await sandbox.clearCredentialEgress();
  const previous = installed.get(sandbox) ?? [];
  if (previous.length) {
    if (!sandbox.setEnvVars) throw new Error("Sandbox cannot clear credential environment");
    await sandbox.setEnvVars(Object.fromEntries(previous.map(name => [name, ""])));
    installed.delete(sandbox);
  }
  if (!supportsCredentialEgress(sandbox)) await sandbox.exec("if [ -f .oma-egress/ready.json ]; then node -e 'try { process.kill(JSON.parse(require(\"fs\").readFileSync(\".oma-egress/ready.json\")).pid, \"SIGTERM\") } catch {}'; fi");
}
/** Provider-neutral lifecycle. Native adapters own interception; otherwise the
 * sandbox owns its bundled local process, CA files, readiness and cleanup. */
export async function prepareSandboxEgress(input: {
  sandbox: SandboxPort;
  scope: { workspaceId: string; sessionId: string; vaultIds: readonly string[] };
  relay: { endpoint: string; pass: string; ca?: string };
  issuePass(): Promise<string>;
  placeholders(scope: { workspaceId: string; sessionId: string; vaultIds: readonly string[] }): Promise<Record<string, string>>;
}): Promise<PreparedSandboxEgress> {
  const { sandbox, scope } = input;
  const previous = installed.get(sandbox) ?? [];
  const replace = async (env: Record<string, string>) => {
    if (!sandbox.setEnvVars) throw new Error("Sandbox cannot install credential environment");
    await sandbox.setEnvVars({ ...Object.fromEntries(previous.filter(name => !(name in env)).map(name => [name, ""])), ...env });
    installed.set(sandbox, Object.keys(env));
  };
  if (scope.vaultIds.length === 0) { await clearSandboxEgress(sandbox); return {}; }
  const placeholders = await input.placeholders(scope);
  const binding = { ...input.relay, pass: await input.issuePass() };
  if (new URL(binding.endpoint).protocol !== "https:") throw new Error("Credential relay endpoint must use HTTPS");
  if (supportsCredentialEgress(sandbox)) {
    await sandbox.prepareCredentialEgress(binding); await replace(placeholders); return {};
  }
  // No provider daemon API is assumed: exec + files work even on adapters
  // without startProcess. A bounded probe distinguishes failure from success.
  const source = await relayBundle();
  if (source === undefined) throw new Error("Sandbox relay bundle unavailable");
  const pathOutput = await sandbox.exec("mkdir -p .oma-egress && chmod 700 .oma-egress && printf 'EGRESS_DIR:' && cd .oma-egress && pwd", 5000);
  if (!/EGRESS_DIR:(\/[^\r\n]+)/u.test(pathOutput)) throw new Error("Sandbox cannot create local relay directory");
  // /workspace is the logical root shared by every adapter. writeFile returns
  // the executable path (local conformance adapters may map it to a host dir).
  const entry = await sandbox.writeFile("/workspace/.oma-egress/relay.cjs", source);
  const directory = entry.slice(0, entry.lastIndexOf("/"));
  await sandbox.writeFile("/workspace/.oma-egress/binding.next.json", JSON.stringify({ ...binding, directory }));
  await sandbox.exec(`chmod 600 ${quote(`${directory}/binding.next.json`)} && mv ${quote(`${directory}/binding.next.json`)} ${quote(`${directory}/binding.json`)}`, 5000);
  const ready = `${directory}/ready.json`;
  if (sandbox.destroy && !lifecycles.has(sandbox)) {
    const destroy = sandbox.destroy.bind(sandbox);
    sandbox.destroy = async () => {
      try { await sandbox.exec(`node -e ${quote(`try{process.kill(JSON.parse(require('fs').readFileSync(${JSON.stringify(ready)})).pid,'SIGTERM')}catch{}`)}`, 3000); }
      finally { await destroy(); }
    };
    lifecycles.add(sandbox);
  }
  const probe = `const fs=require('fs'),http=require('http');try{const r=JSON.parse(fs.readFileSync(${JSON.stringify(ready)}));process.kill(r.pid,0);const q=http.get({host:'127.0.0.1',port:r.port,path:'/health',timeout:1000},s=>{s.resume();process.exit(s.statusCode===200?0:1)});q.on('error',()=>process.exit(1));q.on('timeout',()=>{q.destroy();process.exit(1)})}catch{process.exit(1)}`;
  const script = `set -eu; command -v node >/dev/null; chmod 600 ${quote(`${directory}/binding.json`)}; if ! node -e ${quote(probe)}; then rm -f ${quote(ready)}; (unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NODE_USE_ENV_PROXY NODE_EXTRA_CA_CERTS; nohup node ${quote(entry)} ${quote(directory)} >${quote(`${directory}/relay.log`)} 2>&1 </dev/null &); fi; i=0; until node -e ${quote(probe)}; do i=$((i+1)); if [ "$i" -ge 30 ]; then echo 'Sandbox credential relay did not become ready'; exit 1; fi; sleep 0.1; done; printf 'EGRESS_READY:'; cat ${quote(ready)}`;
  const output = await sandbox.exec(script, 15000);
  const matched = /EGRESS_READY:(\{[^\n]+\})/u.exec(output);
  if (!matched) throw new Error("Sandbox credential relay installation/readiness failed");
  const state = JSON.parse(matched[1]!) as { pid: number; port: number; caFile: string; caBundleFile: string };
  if (!Number.isSafeInteger(state.pid) || !Number.isSafeInteger(state.port)) throw new Error("Invalid sandbox relay readiness");
  const proxy = `http://127.0.0.1:${state.port}`;
  await replace({ ...placeholders, HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: state.caFile, SSL_CERT_FILE: state.caBundleFile, REQUESTS_CA_BUNDLE: state.caBundleFile,
    CURL_CA_BUNDLE: state.caBundleFile, GIT_SSL_CAINFO: state.caBundleFile, AWS_CA_BUNDLE: state.caBundleFile, DENO_CERT: state.caFile,
  });
  return state;
}
