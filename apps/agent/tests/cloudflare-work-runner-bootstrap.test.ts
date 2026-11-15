import { afterEach, expect, it } from "vitest";
import { CloudflareSandbox, setCloudflareSandboxForTest } from "../src/runtime/sandbox";

afterEach(() => setCloudflareSandboxForTest(undefined));
const input = () => ({ command: "/opt/openma/bin/openma-acp-work-item", controlPlaneOrigin: "https://control.test", env: {
  ANTHROPIC_BASE_URL: "https://control.test", ANTHROPIC_ENVIRONMENT_ID: "env", ANTHROPIC_SESSION_ID: "sess", ANTHROPIC_WORK_ID: "work", ANTHROPIC_WORK_SECRET: btoa(JSON.stringify({ sessions_token: "sk-ant-req-v1.scoped-work-bearer", api_base_url: "https://control.test", claim_generation: 1 })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), OPENMA_HARNESS_ID: "agent", OPENMA_HARNESS_VERSION: "1", OPENMA_WORKSPACE_ID: "ws",
} });
function fixture(failure?: Error) {
  const calls: unknown[] = [];
  setCloudflareSandboxForTest({
    async restrictOutboundToHosts(hosts: string[]) { calls.push(["restrict", hosts]); },
    async startProcess(command: string, options: unknown) { calls.push(["start", command, options]); if (failure) throw failure; return { id: "process", pid: 42, async kill(signal: string) { calls.push(["kill", signal]); }, async getStatus() { return "running"; } }; },
    async exec() { throw new Error("Must not fallback to exec"); },
  });
  const sandbox = new CloudflareSandbox({ SANDBOX: {} } as never, "sess");
  return { sandbox, calls };
}
it("starts only the installed Work runner with explicit scoped env after limiting control-plane network", async () => {
  const f = fixture();
  const process = await f.sandbox.startWorkRunner(input());
  expect(f.calls).toEqual([["restrict", ["control.test"]], ["start", "exec '/opt/openma/bin/openma-acp-work-item'", { env: input().env, cwd: "/workspace", environmentMode: "replace" }]]);
  expect(process.id).toBe("process");
  expect(await process.getStatus()).toBe("running");
  expect("stdin" in process).toBe(false); expect("stdout" in process).toBe(false); expect("getLogs" in process).toBe(false);
  await process.kill("SIGTERM"); expect(f.calls.at(-1)).toEqual(["kill", "SIGTERM"]);
});
it("native launch rejection preserves unknown dispatch and never retries or falls back", async () => {
  const failure = new Error("provider disconnected"); const f = fixture(failure);
  await expect(f.sandbox.startWorkRunner(input())).rejects.toBe(failure);
  expect(f.calls.filter(c => (c as unknown[])[0] === "start")).toHaveLength(1);
});
it.each(["file:///workspace", "https://u:p@control.test", "https://control.test/path", "https://control.test?x=1"])("invalid control-plane origin refuses before provider effects: %s", async controlPlaneOrigin => {
  const f = fixture(); await expect(f.sandbox.startWorkRunner({ ...input(), controlPlaneOrigin })).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it("mismatched Work base URL refuses before provider effects", async () => {
  const f = fixture(); const spec = input(); spec.env.ANTHROPIC_BASE_URL = "https://other.test";
  await expect(f.sandbox.startWorkRunner(spec)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it("standing environment key and model credentials never enter bootstrap", async () => {
  const f = fixture(); const spec = input();
  await expect(f.sandbox.startWorkRunner({ ...spec, env: { ...spec.env, ANTHROPIC_ENVIRONMENT_KEY: "standing-private" } })).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("missing network enforcement fails closed without launch", async () => {
  let starts = 0; setCloudflareSandboxForTest({ async startProcess() { starts++; } });
  const sandbox = new CloudflareSandbox({ SANDBOX: {} } as never, "sess");
  await expect(sandbox.startWorkRunner(input())).rejects.toThrow(); expect(starts).toBe(0);
});

it.each(["relative", "/opt/../bin/runner", "/opt/runner;bad"])("invalid installed command fails before effects: %s", async command => {
  const f = fixture(); await expect(f.sandbox.startWorkRunner({ ...input(), command })).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it("another Session cannot bootstrap into this sandbox", async () => {
  const f = fixture(); const spec = input(); spec.env.ANTHROPIC_SESSION_ID = "other";
  await expect(f.sandbox.startWorkRunner(spec)).rejects.toThrow(); expect(f.calls).toEqual([]);
});
it("network restriction rejection prevents launch without fallback", async () => {
  const failure = new Error("network unavailable"); let starts = 0;
  setCloudflareSandboxForTest({ async restrictOutboundToHosts() { throw failure; }, async startProcess() { starts++; } });
  await expect(new CloudflareSandbox({ SANDBOX: {} } as never, "sess").startWorkRunner(input())).rejects.toBe(failure); expect(starts).toBe(0);
});
it("takes immutable bootstrap env before an asynchronous network boundary", async () => {
  const spec = input(); let launched: Record<string, string> | undefined;
  setCloudflareSandboxForTest({ async restrictOutboundToHosts() { spec.env.ANTHROPIC_SESSION_ID = "other"; }, async startProcess(_command: string, options: { env: Record<string, string> }) { launched = options.env; return { id: "p", pid: 1, async kill() {}, async getStatus() { return "running"; } }; } });
  await new CloudflareSandbox({ SANDBOX: {} } as never, "sess").startWorkRunner(spec);
  expect(launched?.ANTHROPIC_SESSION_ID).toBe("sess");
});

it.each([
  JSON.stringify({ sessions_token: "sk-ant-req-v1.not-encoded" }),
  btoa(JSON.stringify({ sessions_token: "oma_sbx_not-work", api_base_url: "https://control.test" })),
  btoa(JSON.stringify({ sessions_token: "sk-ant-req-v1.control", api_base_url: "https://other.test" })),
  btoa(JSON.stringify({ api_base_url: "https://control.test" })),
])("malformed or wrong-origin Work delivery never reaches provider", async ANTHROPIC_WORK_SECRET => {
  const f = fixture(); const spec = input(); spec.env.ANTHROPIC_WORK_SECRET = ANTHROPIC_WORK_SECRET;
  await expect(f.sandbox.startWorkRunner(spec)).rejects.toThrow(); expect(f.calls).toEqual([]);
});

it("real OmaSandbox start and exec replace stale env while preserving only platform CA defaults", async () => {
  const { OmaSandbox } = await import("../src/oma-sandbox");
  const native = Object.create(OmaSandbox.prototype) as any;
  const inherited = { ANTHROPIC_API_KEY: "stale", ANTHROPIC_ENVIRONMENT_KEY: "standing", NODE_OPTIONS: "--require=/tmp/old.js" };
  let received: any, argv: string[] = [];
  Object.defineProperty(native, "ctx", { value: { storage: { kv: { get: () => inherited } }, container: { async exec(a: string[], options: any) { argv = a; received = options.env; return { async output() { return { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 }; } }; } } } });
  native.ensureRunning = async () => {}; native.recordActivity = () => {}; native.track = async (_dirty: boolean, run: () => unknown) => run(); native.restrictOutboundToHosts = async () => {}; native.readFile = async () => ({ content: "42" });
  // Generic process env replacement is independent of SQL-authorized Work
  // launch (covered by cf-native-finalization's real Work/DO launch test).
  await native.startProcess("exec /usr/local/bin/runner", { env: input().env, cwd: "/workspace", environmentMode: "replace" });
  expect(received).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(received).not.toHaveProperty("ANTHROPIC_ENVIRONMENT_KEY"); expect(received).not.toHaveProperty("NODE_OPTIONS");
  expect(received).toMatchObject(input().env); expect(received.NODE_EXTRA_CA_CERTS).toBeTruthy(); expect(received.SSL_CERT_FILE).toBeTruthy();
  expect(argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
});
it("ordinary native startProcess retains existing merged environment semantics", async () => {
  const { OmaSandbox } = await import("../src/oma-sandbox"); const native = Object.create(OmaSandbox.prototype) as any; let received: any;
  Object.defineProperty(native, "ctx", { value: { storage: { kv: { get: () => ({ ORDINARY_ENV: "kept" }) } } } });
  native.ensureRunning = async () => {}; native.recordActivity = () => {}; native.exec = async (_command: string, options: any) => { received = options.env; return { stdout: "", exitCode: 0 }; }; native.readFile = async () => ({ content: "42" });
  await native.startProcess("true", { env: { EXPLICIT: "yes" } }); expect(received.ORDINARY_ENV).toBe("kept"); expect(received.EXPLICIT).toBe("yes"); expect(received.NODE_EXTRA_CA_CERTS).toBeTruthy();
});

it("accepts the existing all-scope holder token as bootstrap delivery without minting another", async () => {
  const { generateSandboxToken } = await import("@open-managed-agents/sandbox-gateway"); const f = fixture(); const token = generateSandboxToken();
  await f.sandbox.startWorkRunner({ ...input(), env: { ...input().env, OPENMA_SANDBOX_TOKEN: token } });
  expect(((f.calls[1] as unknown[])[2] as { env: Record<string,string> }).env.OPENMA_SANDBOX_TOKEN).toBe(token);
});
