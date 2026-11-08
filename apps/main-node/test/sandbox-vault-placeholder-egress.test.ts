// Vault environment_variable placeholders through the in-sandbox relay
// (design §8.4 rules 2 and 6; e2e session__ie7dakcwG71DL90IVY3t sent the
// placeholder to a non-allowed host and got 200). The allowed host gets the
// real value; any other host gets 403 and is never dialed with the
// placeholder; a request without a placeholder still goes straight upstream.
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess";
import { createEgressCertificateAuthority, loadOrCreateEgressCa } from "../../../packages/sandbox-egress/src/ca";
import { prepareSandboxEgress } from "../../../packages/sandbox-egress/src/install";
import { createCredentialEgressRelay, createEgressRelayPasses } from "../../../packages/managed-credential-resolver/src/relay";
import { ManagedCredentialResolver } from "../../../packages/managed-credential-resolver/src/resolver";
import { createVaultPlaceholders } from "../../../packages/sandbox-gateway/src/vault-substitution";
import { builtinSpecs, createSpecRegistry } from "../../../packages/cap/src/index";
import type { CredentialStore, StoredCredential } from "../../../packages/credential-store/src/index";
import { buildCredentialEgressRoutes } from "../../../packages/managed-agents-adapters-http/src/credential-egress";
import { sendDirectHttps } from "../../../packages/sandbox-egress/src/direct-https";

const SECRET = "real-value-0123456789";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function listen(server: ReturnType<typeof createServer> | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return (server.address() as { port: number }).port;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "oma-vault-relay-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const upstreamCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream")));
  const seen: Array<{ host: string; value: string }> = [];
  const record = (host: string, value: unknown) => seen.push({ host, value: String(value) });
  // "localhost" is the credential's allowed host; "127.0.0.1" is any other host.
  const allowed = createServer(await upstreamCA.leafFor("localhost"), (request, response) => { record("allowed", request.headers["x-secret"]); response.end("ok"); });
  const other = createServer(await upstreamCA.leafFor("127.0.0.1"), (request, response) => { record("other", request.headers["x-secret"]); response.end("ok"); });
  const plain = createHttpServer((request, response) => { record("plain", request.headers["x-secret"]); response.end("ok"); });
  const ports = { allowed: await listen(allowed), other: await listen(other), plain: await listen(plain) };
  const row: StoredCredential = { revision: 1, credential: {
    id: "cred_env", vaultId: "vault", metadata: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01", archivedAt: null,
    auth: { type: "environment_variable", secretName: "OMA_SECRET", secretValue: SECRET, networking: { type: "limited", allowedHosts: ["localhost"] }, injectionLocation: { header: true, body: false } },
  } as StoredCredential["credential"] };
  const credentials: CredentialStore = {
    list: async ({ vaultId }) => vaultId === "vault" ? [row] : [], find: async () => row,
    insert: async () => { throw new Error("unused"); }, replace: async () => { throw new Error("unused"); },
    archive: async () => ({ type: "not_found" }), delete: async () => ({ type: "not_found" }),
  };
  const refused: Array<Record<string, unknown>> = [];
  const resolver = new ManagedCredentialResolver({
    credentials, vaults: { find: async () => ({ vault: { archivedAt: null } }) }, clock: { now: () => new Date() },
    log: { warn() {} }, fetch: async () => new Response("unused", { status: 500 }), placeholders: createVaultPlaceholders("root"),
  }, createSpecRegistry(builtinSpecs));
  const passes = createEgressRelayPasses("root", Date.now);
  const relay = createCredentialEgressRelay({
    passes, credentials: resolver,
    authorize: async (claims) => ({ workspaceId: claims.workspaceId, sessionId: claims.sessionId, vaultIds: ["vault"] }),
    send: (request) => sendDirectHttps(request, upstreamCA.certificatePem),
    log: { warn: (fields) => { refused.push(fields); } },
  });
  const routes = new Hono().route("/v1/oma/egress", buildCredentialEgressRoutes(() => relay));
  const controlCA = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "control")));
  const control = createServer(await controlCA.leafFor("localhost"), async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    const response = await routes.fetch(new Request(`https://control.example${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>, body: Buffer.concat(chunks) }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>).pipe(outgoing);
    else outgoing.end();
  });
  const controlPort = await listen(control);
  const sandbox = new LocalSubprocessSandbox({ workdir: join(dir, "sandbox") });
  cleanup.push(() => sandbox.destroy());
  const scope = { workspaceId: "ws", sessionId: "session", vaultIds: ["vault"] };
  await prepareSandboxEgress({
    sandbox, scope, // upstreamCa: the relay's direct upstreams trust the fixture CA the way real ones trust public roots.
    relay: { endpoint: `https://localhost:${controlPort}`, pass: "", ca: controlCA.certificatePem, upstreamCa: upstreamCA.certificatePem },
    issuePass: () => passes.issue({ workspaceId: "ws", sessionId: "session", executionId: "exe", attemptId: "att", ownerId: "owner", generation: 1, ttlMs: 60_000 }),
    placeholders: (s) => resolver.placeholderEnvironment(s),
  });
  const curl = (url: string, header: string) => sandbox.exec(`curl -sS --noproxy '' -o /dev/null -w 'HTTP=%{http_code}' -H "${header}" '${url}' 2>&1`);
  return { sandbox, ports, seen, refused, curl };
}

describe("Vault environment_variable placeholders at sandbox egress", () => {
  it("holds only the placeholder in the sandbox env", async () => {
    const f = await fixture();
    const env = await f.sandbox.exec('printf %s "$OMA_SECRET"');
    expect(env).toMatch(/^oma_vault_[A-Za-z0-9_-]{43}$/u);
    expect(env).not.toContain(SECRET);
  });

  it("substitutes the real value on the credential's allowed host", async () => {
    const f = await fixture();
    expect(await f.curl(`https://localhost:${f.ports.allowed}/`, "x-secret: $OMA_SECRET")).toContain("HTTP=200");
    expect(f.seen).toEqual([{ host: "allowed", value: SECRET }]);
  });

  it("refuses the placeholder on any other host with 403 and never dials it", async () => {
    const f = await fixture();
    expect(await f.curl(`https://127.0.0.1:${f.ports.other}/`, "x-secret: $OMA_SECRET")).toContain("HTTP=403");
    expect(await f.curl(`http://127.0.0.1:${f.ports.plain}/`, "x-secret: $OMA_SECRET")).toContain("HTTP=403");
    expect(f.seen).toEqual([]);
    expect(f.refused).toEqual([expect.objectContaining({ op: "credential_egress.placeholder_refused", rule: "credential_host_mismatch", host: "127.0.0.1" })]);
  });

  it("still sends requests without a placeholder straight to other hosts", async () => {
    const f = await fixture();
    expect(await f.curl(`https://127.0.0.1:${f.ports.other}/`, "x-secret: plain")).toContain("HTTP=200");
    expect(await f.curl(`http://127.0.0.1:${f.ports.plain}/`, "x-secret: plain")).toContain("HTTP=200");
    expect(f.seen).toEqual([{ host: "other", value: "plain" }, { host: "plain", value: "plain" }]);
  });
});
