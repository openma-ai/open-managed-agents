import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess";
import { createEgressCertificateAuthority, loadOrCreateEgressCa } from "../../../packages/sandbox-egress/src/ca";
import { prepareSandboxEgress } from "../../../packages/sandbox-egress/src/install";
import { createCredentialEgressRelay, createEgressRelayPasses } from "../../../packages/managed-credential-resolver/src/relay";
import { ManagedCredentialResolver } from "../../../packages/managed-credential-resolver/src/resolver";
import { builtinSpecs, createSpecRegistry } from "../../../packages/cap/src/index";
import type { StoredCredential, CredentialStore } from "../../../packages/credential-store/src/index";
import { buildCredentialEgressRoutes } from "../../../packages/managed-agents-adapters-http/src/credential-egress";
import { Hono } from "hono";
import { sendDirectHttps } from "../../../packages/sandbox-egress/src/direct-https";
const run = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "oma-local-relay-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const upstreamCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream")));
  let status = 200; let refreshOk = true; let archivedAt: string | null = null; let vaultIds = ["vault"];
  const seen: Array<{ token?: string; path: string; body: Buffer; headers: Record<string, unknown> }> = [];
  let refreshes = 0;
  const upstream = createServer(await upstreamCA.leafFor("localhost"), async (request, response) => {
    const parts: Buffer[] = []; for await (const chunk of request) parts.push(chunk);
    seen.push({ token: request.headers.authorization, path: request.url!, body: Buffer.concat(parts), headers: request.headers });
    response.writeHead(status === 401 && request.headers.authorization === "Bearer fresh-token" ? 200 : status, { "content-type": "application/octet-stream" });
    response.end(Buffer.from([0, 255, 128]));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const target = `https://localhost:${(upstream.address() as { port: number }).port}`;
  let row: StoredCredential = { revision: 1, credential: { id: "cred", vaultId: "vault", metadata: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", archivedAt: null, auth: { type: "mcp_oauth", mcpServerUrl: target, accessToken: "real-token", refresh: { refreshToken: "refresh", clientId: "client", tokenEndpoint: "https://auth.example/token", tokenEndpointAuth: { type: "none" } } } } };
  const credentials: CredentialStore = {
    insert: async () => { throw new Error("unused"); }, find: async () => row,
    replace: async ({ next }) => { row = { revision: row.revision + 1, credential: next }; return { type: "replaced", record: row }; },
    archive: async () => ({ type: "not_found" }), delete: async () => ({ type: "not_found" }), list: async ({ vaultId }) => vaultId === "vault" ? [row] : [],
  };
  const resolver = new ManagedCredentialResolver({ credentials, clock: { now: () => new Date() }, log: { warn() {} }, fetch: async () => { refreshes++; return refreshOk ? Response.json({ access_token: "fresh-token" }) : new Response("no", { status: 400 }); } }, createSpecRegistry(builtinSpecs));
  const passes = createEgressRelayPasses("root", Date.now);
  const relay = createCredentialEgressRelay({ passes, credentials: resolver, findSession: async () => ({ vaultIds, archivedAt }), send: request => sendDirectHttps(request, upstreamCA.certificatePem) });
  const routes = new Hono().route("/v1/oma/egress", buildCredentialEgressRoutes(() => relay));
  const controlCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "control-test")));
  const control = createServer(await controlCA.leafFor("localhost"), async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    const response = await routes.fetch(new Request(`https://control.example${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); });
  const endpoint = `https://localhost:${(control.address() as { port: number }).port}`;
  const sandbox = new LocalSubprocessSandbox({ workdir: join(dir, "sandbox-a") });
  cleanup.push(() => sandbox.destroy());
  const scope = { workspaceId: "ws", sessionId: "session", vaultIds: ["vault"] };
  const prepare = (box = sandbox) => prepareSandboxEgress({ sandbox: box, scope, relay: { endpoint, pass: "", ca: controlCA.certificatePem }, issuePass: () => passes.issue({ workspaceId: "ws", sessionId: "session", ttlMs: 60000 }), placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }) });
  return { dir, sandbox, target, prepare, seen, get refreshes() { return refreshes; }, setStatus: (value: number) => { status = value; }, failRefresh: () => { refreshOk = false; }, setVaults: (value: string[]) => { vaultIds = value; }, archive: () => { archivedAt = "now"; } };
}

describe("sandbox-owned local credential relay", () => {
  it("runs a real CLI via localhost and ordinary HTTPS relay with placeholders only in the client", async () => {
    const f = await fixture(); await f.prepare();
    const output = await f.sandbox.exec(`printf '%s\\n' "$GITHUB_TOKEN"; curl -sS --noproxy '' -H "Authorization: Bearer $GITHUB_TOKEN" '${f.target}/a%2Fb?q=one%20two' | od -An -tu1`);
    expect(output).toContain("__cap_managed__"); expect(output).toMatch(/0\s+255\s+128/); expect(output).not.toContain("real-token");
    expect(f.seen).toHaveLength(1); expect(f.seen[0]).toMatchObject({ token: "Bearer real-token", path: "/a%2Fb?q=one%20two" });
    expect(f.seen[0]!.headers).not.toHaveProperty("proxy-authorization");
  });

  it("replays binary POST only on successful refresh and rechecks current Vaults and archive state", async () => {
    const f = await fixture(); await f.prepare(); f.setStatus(401);
    const bodyPath = await f.sandbox.writeFile("payload.b64", "AP8BgA==");
    const call = () => f.sandbox.exec(`base64 -d < '${bodyPath}' | curl -sS --noproxy '' -o /dev/null -w '%{http_code}' -X POST --data-binary @- '${f.target}/binary?q=1'`);
    expect(await call()).toContain("200"); expect(f.refreshes).toBe(1); expect(f.seen).toHaveLength(2);
    expect(f.seen.map(row => row.body)).toEqual([Buffer.from([0,255,1,128]), Buffer.from([0,255,1,128])]);
    f.setVaults([]); expect(await call()).toContain("403"); expect(f.seen).toHaveLength(2);
    f.setVaults(["vault"]); f.archive(); expect(await call()).toMatch(/403|502/); expect(f.seen).toHaveLength(2);
  });

  it.each([401, 403])("does not resend failed refresh or forbidden %s", async status => {
    const f = await fixture(); await f.prepare(); f.setStatus(status); f.failRefresh();
    await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null '${f.target}/'`);
    expect(f.seen).toHaveLength(1); expect(f.refreshes).toBe(status === 401 ? 1 : 0);
  });

  it("uses independent sandbox CAs and repairs a killed warm relay before commands run", async () => {
    const f = await fixture(); const a = await f.prepare();
    const b = new LocalSubprocessSandbox({ workdir: join(f.dir, "sandbox-b") }); cleanup.push(() => b.destroy());
    const other = await f.prepare(b);
    expect(await readFile(a.caFile!, "utf8")).not.toBe(await readFile(other.caFile!, "utf8"));
    for (const box of [f.sandbox, b]) expect(await box.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/'`)).toContain("200");
    await run("kill", ["-KILL", String(a.pid)]);
    const repaired = await f.prepare(); expect(repaired.pid).not.toBe(a.pid);
    expect(await f.sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w '%{http_code}' '${f.target}/warm'`)).toContain("200");
  });
});
