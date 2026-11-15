// The sandbox-owned credential relay against a real control-plane route,
// real TLS upstream and a LocalSubprocessSandbox (real relay, mv and curl
// processes), shared by sandbox-local-egress and the delivery race tests.
import { createServer } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { LocalSubprocessSandbox } from "../../../../packages/sandbox/src/adapters/local-subprocess";
import { createEgressCertificateAuthority, loadOrCreateEgressCa } from "../../../../packages/sandbox-egress/src/ca";
import { prepareSandboxEgress } from "../../../../packages/sandbox-egress/src/install";
import { sendDirectHttps } from "../../../../packages/sandbox-egress/src/direct-https";
import { createCredentialEgressRelay } from "../../../../packages/managed-credential-resolver/src/relay";
import { ManagedCredentialResolver } from "../../../../packages/managed-credential-resolver/src/resolver";
import { attemptSandboxTokens } from "../../../../packages/sandbox-gateway/src/attempt-sandbox-token";
import { memorySandboxTokens } from "../../../../packages/sandbox-gateway/test/memory-sandbox-token-store";
import { builtinSpecs, createSpecRegistry } from "../../../../packages/cap/src/index";
import type { StoredCredential, CredentialStore } from "../../../../packages/credential-store/src/index";
import { buildCredentialEgressRoutes } from "../../../../packages/managed-agents-adapters-http/src/credential-egress";

export type LocalRelayFixture = Awaited<ReturnType<typeof localRelayFixture>>;

export async function localRelayFixture(cleanup: Array<() => Promise<unknown>>, cliId?: "gh" | "glab", realCli = false) {
  const dir = await mkdtemp(join(tmpdir(), "oma-local-relay-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const upstreamCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream")));
  let status = 200; let refreshOk = true; let vaultIds = ["vault"];
  const seen: Array<{ token?: string; path: string; body: Buffer; headers: Record<string, unknown> }> = [];
  let refreshes = 0;
  const tokens = memorySandboxTokens({ vaultIds: () => vaultIds });
  const upstream = createServer(await upstreamCA.leafFor("localhost"), async (request, response) => {
    const parts: Buffer[] = []; for await (const chunk of request) parts.push(chunk);
    seen.push({ token: request.headers.authorization, path: request.url!, body: Buffer.concat(parts), headers: request.headers });
    if (request.url === "/redirect") { response.writeHead(307, { location: "/next" }); response.end(); return; }
    if (request.url === "/head") { response.writeHead(200, { "content-length": "123", "x-head": "yes" }); response.end(); return; }
    if (request.url === "/gzip") {
      const zipped = gzipSync(Buffer.from([0, 255, 128]));
      response.writeHead(200, { "content-encoding": "gzip", "content-length": String(zipped.length) }); response.end(zipped); return;
    }
    if (request.url === "/stream") {
      response.writeHead(206, { "content-type": "application/octet-stream", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] }); response.write("first");
      setTimeout(() => response.end("last"), 1200); return;
    }
    if ([204, 205, 304].includes(status)) {
      response.writeHead(status, { "x-empty": "yes", ...(status === 304 ? { "content-length": "123" } : status === 205 ? { "content-length": "0" } : {}) }); response.end(); return;
    }
    response.writeHead(status === 401 && request.headers.authorization === "Bearer fresh-token" ? 200 : status, { "content-type": "application/octet-stream" });
    response.end(Buffer.from([0, 255, 128]));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const target = `https://localhost:${(upstream.address() as { port: number }).port}`;
  let row: StoredCredential = { revision: 1, credential: { id: "cred", vaultId: "vault", metadata: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", archivedAt: null, auth: { type: "mcp_oauth", mcpServerUrl: target, accessToken: "real-token", refresh: { refreshToken: "refresh", clientId: "client", tokenEndpoint: "https://auth.example/token", tokenEndpointAuth: { type: "none" } } } } };
  if (cliId) row.credential.auth = { type: "cap_cli", cliId, token: "real-token" };
  const credentials: CredentialStore = {
    insert: async () => { throw new Error("unused"); }, find: async () => row,
    replace: async ({ next }) => { row = { revision: row.revision + 1, credential: next }; return { type: "replaced", record: row }; },
    archive: async () => ({ type: "not_found" }), delete: async () => ({ type: "not_found" }), list: async ({ vaultId }) => vaultId === "vault" ? [row] : [],
  };
  const resolver = new ManagedCredentialResolver({ credentials, vaults: { find: async () => ({ vault: { archivedAt: null } }) }, clock: { now: () => new Date() }, log: { warn() {} }, fetch: async () => { refreshes++; return refreshOk ? Response.json({ access_token: "fresh-token" }) : new Response("no", { status: 400 }); } }, createSpecRegistry(cliId && !realCli ? builtinSpecs.map(spec => spec.cli_id === cliId ? { ...spec, endpoints: ["localhost"] } : spec) : builtinSpecs));
  const relay = createCredentialEgressRelay({ credentials: resolver, authenticate: tokens.authenticate, send: request => sendDirectHttps(realCli ? new Request(`${target}${new URL(request.url).pathname}${new URL(request.url).search}`, request) : request, upstreamCA.certificatePem) });
  const routes = new Hono().route("/v1/oma/egress", buildCredentialEgressRoutes(() => relay));
  const controlCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "control-test")));
  const control = createServer(await controlCA.leafFor("localhost"), async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    const response = await routes.fetch(new Request(`https://control.example${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(response.headers.has("set-cookie") ? { "set-cookie": response.headers.getSetCookie() } : {}) });
    if (response.body) Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>).on("error", () => outgoing.destroy()).pipe(outgoing);
    else outgoing.end();
  });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); });
  const endpoint = `https://localhost:${(control.address() as { port: number }).port}`;
  const sandbox = new LocalSubprocessSandbox({ workdir: join(dir, "sandbox-a") });
  cleanup.push(() => sandbox.destroy());
  const scope = { workspaceId: "ws", sessionId: "session", vaultIds: ["vault"] };
  const issued: string[] = [];
  const holder = attemptSandboxTokens();
  const prepare = (box = sandbox) => prepareSandboxEgress({ sandbox: box, scope, relay: { endpoint, ca: controlCA.certificatePem }, issueToken: () => holder.relayDelivery(tokens.fence, async () => { const token = await tokens.issue(); issued.push(token); return token; }, box), placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }) });
  const workdir = join(dir, "sandbox-a");
  return { dir, workdir, egressDir: join(workdir, ".oma-egress"), relayConfig: { endpoint, ca: controlCA.certificatePem }, sandbox, target, prepare, seen, issued, tokens, upstreamPem: upstreamCA.certificatePem, settle: () => tokens.settle(), get refreshes() { return refreshes; }, setStatus: (value: number) => { status = value; }, failRefresh: () => { refreshOk = false; }, setVaults: (value: string[]) => { vaultIds = value; }, archive: () => tokens.archive() };
}
