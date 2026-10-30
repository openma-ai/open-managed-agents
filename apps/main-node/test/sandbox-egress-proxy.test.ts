// Sandbox egress proxy: pass, sandbox environment, and the proxy itself
// against a real self-signed HTTPS upstream with curl as the sandbox client.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpritesClient } from "@fly/sprites";
import { SpritesRuntime, type SpritesClientPort } from "../../../packages/managed-runtime-sprites/src/sprites.js";
import { sandboxProvider as openSandboxProvider } from "../../../packages/sandbox-adapter-opensandbox/src/index.js";
import { mockSdkServer } from "../../../packages/sandbox-adapter-opensandbox/test/sdk-http.js";
import { builtinSpecs, createSpecRegistry } from "../../../packages/cap/src/index.js";
import type { CredentialStore, StoredCredential } from "../../../packages/credential-store/src/index.js";
import { ManagedCredentialResolver } from "../../../packages/managed-credential-resolver/src/index.js";
import {
  createEgressCertificateAuthority,
  loadOrCreateEgressCa,
} from "../../../packages/control-plane-node/src/lib/sandbox-egress/ca.js";
import {
  applySandboxEgress,
  sandboxEgressEnvironment,
  SANDBOX_EGRESS_CA_BUNDLE_PATH,
  SANDBOX_EGRESS_CA_PATH,
} from "../../../packages/control-plane-node/src/lib/sandbox-egress/environment.js";
import {
  createEgressPassAuthority,
  passFromProxyAuthorization,
} from "../../../packages/control-plane-node/src/lib/sandbox-egress/pass.js";
import {
  createSandboxEgressProxy,
  type EgressCredentialSource,
  type EgressSessionRecord,
} from "../../../packages/control-plane-node/src/lib/sandbox-egress/proxy.js";
import { loadNodeConfig } from "../src/config";
import { createBetterSqlite3SqlClient, type SqlClient } from "../../../packages/sql-client/src/index.js";
import { createNodeSecrets } from "../../../packages/control-plane-node/src/secrets.js";
import { startSandboxEgressProxy } from "../../../packages/control-plane-node/src/lib/sandbox-egress/index.js";
import { SqlEgressCaStore } from "../../../packages/control-plane-node/src/lib/sandbox-egress/sql-ca-store.js";

const run = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.unstubAllGlobals();
});

const clockAt = (ms: number) => ({ now: () => new Date(ms) });

describe("egress pass", () => {
  const passes = createEgressPassAuthority("root-secret", clockAt(1_000));

  it("round-trips the workspace and Session it was issued for", () => {
    const pass = passes.issue({ workspaceId: "ws_a", sessionId: "sesn_a", ttlMs: 60_000 });
    expect(passes.verify(pass)).toEqual({
      type: "valid",
      claims: { workspaceId: "ws_a", sessionId: "sesn_a", expiresAt: 61_000 },
    });
  });

  it("expires", () => {
    const pass = passes.issue({ workspaceId: "ws_a", sessionId: "sesn_a", ttlMs: 60_000 });
    expect(createEgressPassAuthority("root-secret", clockAt(61_000)).verify(pass).type).toBe("expired");
  });

  it("cannot be re-pointed at another Session or workspace", () => {
    const pass = passes.issue({ workspaceId: "ws_a", sessionId: "sesn_a", ttlMs: 60_000 });
    const [, signature] = pass.split(".");
    for (const claims of [
      { workspaceId: "ws_a", sessionId: "sesn_b", expiresAt: 61_000 },
      { workspaceId: "ws_b", sessionId: "sesn_a", expiresAt: 61_000 },
    ]) {
      const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
      expect(passes.verify(forged).type).toBe("invalid");
    }
  });

  it("is bound to the deployment's root secret", () => {
    const foreign = createEgressPassAuthority("other-root", clockAt(1_000))
      .issue({ workspaceId: "ws_a", sessionId: "sesn_a", ttlMs: 60_000 });
    expect(passes.verify(foreign).type).toBe("invalid");
    expect(passes.verify("garbage").type).toBe("invalid");
  });

  it("is read from the proxy URL userinfo clients send as Basic", () => {
    const header = `Basic ${Buffer.from("openma:abc.def").toString("base64")}`;
    expect(passFromProxyAuthorization(header)).toBe("abc.def");
    expect(passFromProxyAuthorization(undefined)).toBeNull();
    expect(passFromProxyAuthorization("Bearer abc")).toBeNull();
  });
});

describe("sandbox egress environment", () => {
  it("points every proxy and CA variable at the proxy and written CA files", () => {
    const env = sandboxEgressEnvironment({
      publicUrl: "http://egress.example:3128",
      pass: "p.s",
      caFile: "/tmp/ca.crt",
      caBundleFile: "/tmp/bundle.crt",
    });
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      expect(env[name]).toBe("http://openma:p.s@egress.example:3128");
    }
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/ca.crt");
    for (const name of ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"]) {
      expect(env[name]).toBe("/tmp/bundle.crt");
    }
    expect(env.NO_PROXY).toContain("localhost");
  });

  const fakeSandbox = () => {
    const files: Record<string, string> = {};
    const env: Record<string, string> = {};
    return {
      files,
      env,
      sandbox: {
        writeFile: async (path: string, content: string) => {
          files[path] = content;
          return `/host${path}`;
        },
        setEnvVars: async (vars: Record<string, string>) => {
          Object.assign(env, vars);
        },
      },
    };
  };
  const log = { info: () => {}, warn: (..._args: unknown[]) => {} };
  const scope = { workspaceId: "ws_a", sessionId: "sesn_a", vaultIds: ["vlt_a"] };

  it("writes the CA and sets placeholders, proxy and CA variables", async () => {
    const { files, env, sandbox } = fakeSandbox();
    const passes = createEgressPassAuthority("root", clockAt(0));
    const result = await applySandboxEgress({
      sandbox,
      scope,
      placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }),
      egress: {
        type: "enabled",
        settings: { publicUrl: "http://egress.example:3128", caCertificatePem: "CA-PEM", passes, passTtlMs: 1_000 },
      },
      log,
    });
    expect(result).toEqual({ proxied: true, placeholders: ["GITHUB_TOKEN"] });
    expect(files[SANDBOX_EGRESS_CA_PATH]).toBe("CA-PEM");
    expect(files[SANDBOX_EGRESS_CA_BUNDLE_PATH]).toMatch(/BEGIN CERTIFICATE[\s\S]*CA-PEM\n$/u);
    expect(env.GITHUB_TOKEN).toBe("__cap_managed__");
    expect(env.NODE_EXTRA_CA_CERTS).toBe(`/host${SANDBOX_EGRESS_CA_PATH}`);
    const pass = new URL(env.HTTPS_PROXY!).password;
    expect(passes.verify(pass)).toMatchObject({ type: "valid", claims: { workspaceId: "ws_a", sessionId: "sesn_a" } });
  });

  it("refuses to prepare a Session needing CLI injection while the proxy is unavailable", async () => {
    const { env, sandbox } = fakeSandbox();
    await expect(applySandboxEgress({
      sandbox,
      scope,
      placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }),
      egress: { type: "unavailable", reason: "no public address" },
      log,
    })).rejects.toThrow(/GITHUB_TOKEN.*unavailable: no public address/u);
    expect(env).toEqual({});
  });

  it("lets Sessions without CLI credentials start while the proxy is unavailable", async () => {
    const { env, sandbox } = fakeSandbox();
    await expect(applySandboxEgress({
      sandbox,
      scope,
      placeholders: async () => ({}),
      egress: { type: "unavailable", reason: "no public address" },
      log,
    })).resolves.toEqual({ proxied: false, placeholders: [] });
    expect(env).toEqual({});
  });

  it("leaves Sessions without Vaults alone", async () => {
    const { env, sandbox } = fakeSandbox();
    await applySandboxEgress({
      sandbox,
      scope: { ...scope, vaultIds: [] },
      placeholders: async () => { throw new Error("not consulted"); },
      egress: { type: "unavailable", reason: "x" },
      log,
    });
    expect(env).toEqual({});
  });

  it("refuses a sandbox that cannot take environment variables", async () => {
    await expect(applySandboxEgress({
      sandbox: { writeFile: async (p: string) => p },
      scope,
      placeholders: async () => ({}),
      egress: {
        type: "enabled",
        settings: { publicUrl: "http://e:1", caCertificatePem: "CA", passes: createEgressPassAuthority("r", clockAt(0)), passTtlMs: 1 },
      },
      log,
    })).rejects.toThrow(/environment variables/u);
  });
});

describe("shared sandbox egress provider wiring", () => {
  const scope = { workspaceId: "ws_a", sessionId: "sesn_a", vaultIds: ["vlt_a"] };
  const egress = {
    type: "enabled" as const,
    settings: {
      publicUrl: "http://egress.example:3128",
      caCertificatePem: "PUBLIC-CA-ONLY",
      passes: createEgressPassAuthority("root", clockAt(0)),
      passTtlMs: 60_000,
    },
  };
  const wire = (sandbox: Parameters<typeof applySandboxEgress>[0]["sandbox"]) => applySandboxEgress({
    sandbox, scope, egress,
    placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }),
    log: { info: () => {}, warn: () => {} },
  });

  it("writes public CA files and forwards the shared environment through OpenSandbox's real SDK", async () => {
    const server = mockSdkServer();
    const sandbox = await openSandboxProvider.create(
      { sessionId: "sesn_a", workdir: "/workspace" },
      { OPENSANDBOX_DOMAIN: "control.test:8080", OPENSANDBOX_API_KEY: "provider-secret" },
    );
    cleanup.push(() => sandbox.destroy());
    await wire(sandbox);
    await sandbox.exec("gh api user");
    const uploads = server.calls.filter((call) => call.url.pathname === "/files/upload");
    const written: Record<string, string> = {};
    for (const upload of uploads) {
      const form = upload.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as { path: string };
      written[metadata.path] = await (form.get("file") as Blob).text();
    }
    expect(Object.keys(written).sort()).toEqual(["/tmp/openma-egress/ca-bundle.crt", "/tmp/openma-egress/ca.crt"]);
    expect(written["/tmp/openma-egress/ca.crt"]).toBe("PUBLIC-CA-ONLY");
    expect(written["/tmp/openma-egress/ca-bundle.crt"]).not.toContain("PRIVATE KEY");
    const command = server.calls.find((call) => call.url.pathname === "/command")!.body as { envs: Record<string, string> };
    expect(command.envs).toMatchObject({
      GITHUB_TOKEN: "__cap_managed__", NODE_EXTRA_CA_CERTS: "/tmp/openma-egress/ca.crt",
      CURL_CA_BUNDLE: "/tmp/openma-egress/ca-bundle.crt",
    });
    expect(new URL(command.envs.HTTPS_PROXY!).host).toBe("egress.example:3128");
  });

  it("writes public CA files and forwards the shared environment through Sprites' real SDK", async () => {
    const writes: Array<{ url: URL; body: string }> = [];
    let executed: URL | undefined;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/fs/write")) {
        writes.push({ url, body: await request.text() });
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/exec")) {
        executed = url;
        return new Response(Uint8Array.of(3, 0));
      }
      throw new Error(`unexpected SDK path ${url.pathname}`);
    });
    const sdk = new SpritesClient("provider-secret", { baseURL: "https://sprites.example", controlMode: false });
    const sandbox = new SpritesRuntime({ client: sdk as unknown as SpritesClientPort, sprite: sdk.sprite("sesn_a") });
    await wire(sandbox);
    await sandbox.exec("gh api user");
    expect(writes.map((write) => write.url.searchParams.get("path")).sort())
      .toEqual(["/tmp/openma-egress/ca-bundle.crt", "/tmp/openma-egress/ca.crt"]);
    expect(writes.every((write) => write.url.searchParams.get("mkdirParents") === "true")).toBe(true);
    expect(writes.find((write) => write.url.searchParams.get("path") === "/tmp/openma-egress/ca.crt")!.body)
      .toBe("PUBLIC-CA-ONLY");
    expect(writes.every((write) => !write.body.includes("PRIVATE KEY"))).toBe(true);
    const env = Object.fromEntries(executed!.searchParams.getAll("env").map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }));
    expect(env).toMatchObject({
      GITHUB_TOKEN: "__cap_managed__", NODE_EXTRA_CA_CERTS: "/tmp/openma-egress/ca.crt",
      CURL_CA_BUNDLE: "/tmp/openma-egress/ca-bundle.crt",
    });
    expect(new URL(env.HTTPS_PROXY!).host).toBe("egress.example:3128");
  });
});

describe("sandbox egress configuration", () => {
  const base = { NODE_ENV: "test", PLATFORM_ROOT_SECRET: "root" };

  it("is on by default at PUBLIC_BASE_URL's host and the default port", () => {
    expect(loadNodeConfig({ ...base, PUBLIC_BASE_URL: "https://openma.example.com/app" }).sandbox.egressProxy).toEqual({
      type: "enabled",
      publicUrl: "http://openma.example.com:8788",
      listenHost: "0.0.0.0",
      listenPort: 8788,
      caDir: "./data/sandbox-egress-ca",
      passTtlMs: 86_400_000,
    });
  });

  it("derives a usable proxy URL from an IPv6 public origin", () => {
    const config = loadNodeConfig({ ...base, PUBLIC_BASE_URL: "https://[2001:db8::1]/" }).sandbox.egressProxy;
    expect(config.type).toBe("enabled");
    if (config.type !== "enabled") throw new Error("proxy unavailable");
    expect(new URL(config.publicUrl).host).toBe("[2001:db8::1]:8788");
  });

  it("takes an explicit address and port", () => {
    const config = loadNodeConfig({
      ...base,
      PUBLIC_BASE_URL: "https://openma.example.com",
      SANDBOX_EGRESS_PROXY_URL: "http://egress.example:3128",
      SANDBOX_EGRESS_PROXY_PORT: "3128",
    }).sandbox.egressProxy;
    expect(config).toMatchObject({
      type: "enabled",
      publicUrl: "http://egress.example:3128",
      listenPort: 3128,
    });
  });

  it("is unavailable, with the reason, without a public address or root secret", () => {
    expect(loadNodeConfig(base).sandbox.egressProxy).toEqual({
      type: "unavailable",
      reason: expect.stringContaining("PUBLIC_BASE_URL"),
    });
    expect(loadNodeConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://o.example" }).sandbox.egressProxy).toEqual({
      type: "unavailable",
      reason: expect.stringContaining("PLATFORM_ROOT_SECRET"),
    });
  });

  it("rejects unusable settings", () => {
    expect(() => loadNodeConfig({ ...base, SANDBOX_EGRESS_PROXY_URL: "https://u:p@egress.example/x" }))
      .toThrow(/must be http:\/\/host:port/u);
    expect(() => loadNodeConfig({ ...base, SANDBOX_EGRESS_PROXY_PORT: "65536" }))
      .toThrow(/SANDBOX_EGRESS_PROXY_PORT/u);
  });
});

// ─── Proxy ────────────────────────────────────────────────────────────────

interface Seen {
  host: string;
  path: string;
  authorization: string | undefined;
  body?: Buffer;
  method?: string;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oma-egress-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An HTTPS upstream for `hostname` signed by its own CA (not the egress CA). */
async function startUpstream(
  hostname: string,
  upstreamCa: Awaited<ReturnType<typeof createEgressCertificateAuthority>>,
  respond: (seen: Seen) => number,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer(await upstreamCa.leafFor(hostname), async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const entry: Seen = {
      host: request.headers.host ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      ...(body.length === 0 ? {} : { body, method: request.method ?? "GET" }),
    };
    seen.push(entry);
    response.writeHead(respond(entry), { "content-type": "text/plain" });
    response.end(`upstream ${hostname}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as { port: number }).port, seen };
}

function memoryStore(records: StoredCredential[]): CredentialStore {
  return {
    insert: async () => { throw new Error("unused"); },
    find: async ({ credentialId }) => records.find((r) => r.credential.id === credentialId) ?? null,
    replace: async (input) => {
      const index = records.findIndex((r) => r.credential.id === input.credentialId);
      if (records[index]!.revision !== input.expectedRevision) {
        return { type: "revision_conflict", actualRevision: records[index]!.revision };
      }
      records[index] = { revision: input.expectedRevision + 1, credential: input.next };
      return { type: "replaced", record: records[index]! };
    },
    archive: async () => ({ type: "not_found" }),
    delete: async () => ({ type: "not_found" }),
    list: async ({ vaultId }) => records.filter((r) => r.credential.vaultId === vaultId),
  };
}

function mcpCredential(id: string, vaultId: string, serverUrl: string, accessToken: string): StoredCredential {
  return {
    revision: 1,
    credential: {
      id,
      vaultId,
      archivedAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      metadata: {},
      auth: {
        type: "mcp_oauth",
        mcpServerUrl: serverUrl,
        accessToken,
        refresh: {
          clientId: "client",
          refreshToken: "refresh-v1",
          tokenEndpoint: "https://auth.invalid/token",
          tokenEndpointAuth: { type: "none" },
        },
      },
    },
  };
}

async function startProxy(input: {
  credentials: EgressCredentialSource;
  /** Keyed by `workspace/session`. */
  sessions?: Record<string, EgressSessionRecord>;
  upstreamCaPem: string;
  clock?: { now(): Date };
}) {
  const dir = await tempDir();
  const ca = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "ca")));
  const passes = createEgressPassAuthority("root", input.clock ?? { now: () => new Date() });
  const logs: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const record = (level: string) => (fields: Record<string, unknown>) => logs.push({ level, fields });
  const proxy = createSandboxEgressProxy({
    passes,
    ca,
    credentials: input.credentials,
    findSession: async ({ workspaceId, sessionId }) =>
      (input.sessions ?? { "ws_a/sesn_a": { vaultIds: ["vlt_a"], archived: false } })[`${workspaceId}/${sessionId}`] ?? null,
    claimsHost: () => false,
    log: { info: record("info"), warn: record("warn"), error: record("error") },
    upstreamCa: input.upstreamCaPem,
  });
  const { port } = await proxy.listen(0, "127.0.0.1");
  cleanup.push(() => proxy.close());
  const caFile = join(dir, "egress-ca.crt");
  await writeFile(caFile, ca.certificatePem);
  return {
    port,
    caFile,
    logs,
    proxyUrl: (sessionId = "sesn_a", workspaceId = "ws_a") =>
      `http://openma:${passes.issue({ workspaceId, sessionId, ttlMs: 60_000 })}@127.0.0.1:${port}`,
    pass: (sessionId = "sesn_a", workspaceId = "ws_a") => passes.issue({ workspaceId, sessionId, ttlMs: 60_000 }),
  };
}

/** curl through the proxy, as a sandbox would via HTTPS_PROXY. */
async function curl(url: string, input: { proxy: string; cacert: string; authorization?: string; bodyFile?: string }) {
  const args = ["-sS", "--max-time", "10", "--proxy", input.proxy, "--cacert", input.cacert, "-o", "-", "-w", "\n%{http_code}"];
  if (input.authorization !== undefined) args.push("-H", `Authorization: ${input.authorization}`);
  if (input.bodyFile !== undefined) args.push("--data-binary", `@${input.bodyFile}`);
  args.push(url);
  try {
    const { stdout } = await run("curl", args, { env: { PATH: process.env.PATH ?? "" } });
    const lines = stdout.trimEnd().split("\n");
    return { status: Number(lines.pop()), body: lines.join("\n"), error: null as string | null };
  } catch (error) {
    return { status: 0, body: "", error: String((error as { stderr?: string }).stderr ?? error) };
  }
}

/** Raw CONNECT, returning the proxy's status line. */
function rawConnect(port: number, authority: string, proxyAuthorization?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${proxyAuthorization === undefined ? "" : `Proxy-Authorization: ${proxyAuthorization}\r\n`}\r\n`);
    });
    socket.once("data", (chunk) => {
      resolve(chunk.toString("utf8").split("\r\n")[0]!);
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

/** CONNECT kept open: status line plus the live socket. */
function openTunnel(port: number, authority: string, proxyAuthorization: string): Promise<{ status: string; socket: import("node:net").Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${proxyAuthorization}\r\n\r\n`);
    });
    cleanup.push(async () => { socket.destroy(); });
    socket.once("data", (chunk) => resolve({ status: chunk.toString("utf8").split("\r\n")[0]!, socket }));
    socket.once("error", reject);
  });
}

async function keepAliveClient(proxy: { port: number; caFile: string; pass(): string }, authority: string) {
  const tunnel = await openTunnel(proxy.port, authority, basic(proxy.pass()));
  expect(tunnel.status).toBe("HTTP/1.1 200 Connection Established");
  const socket = tlsConnect({ socket: tunnel.socket, servername: "localhost", ca: await readFile(proxy.caFile, "utf8") });
  cleanup.push(async () => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  return () => keepAliveGet(socket, authority);
}

function keepAliveGet(socket: TLSSocket, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(data);
    };
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf8");
      const split = data.indexOf("\r\n\r\n");
      if (split < 0) return;
      const length = /content-length: (\d+)/iu.exec(data.slice(0, split));
      if (length ? data.length >= split + 4 + Number(length[1]) : data.endsWith("0\r\n\r\n")) finish();
    };
    const timer = setTimeout(() => finish(new Error("keepalive response timeout")), 5_000);
    socket.on("data", onData);
    socket.once("error", onError);
    // No Proxy-Authorization inside TLS: revalidation must use the CONNECT pass.
    socket.write(`GET /keepalive HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`);
  });
}

const basic = (pass: string) => `Basic ${Buffer.from(`openma:${pass}`).toString("base64")}`;

describe("shared sandbox egress CA", () => {
  async function replicas() {
    const dir = await tempDir();
    const dbPath = join(dir, "shared.sqlite");
    const sqlA = await createBetterSqlite3SqlClient(dbPath);
    const sqlB = await createBetterSqlite3SqlClient(dbPath);
    await sqlA.exec(`CREATE TABLE kv_entries (
      tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER,
      PRIMARY KEY (tenant_id, key)
    )`);
    const upstreamCa = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream")));
    const upstream = await startUpstream("localhost", upstreamCa, () => 200);
    const resolver = new ManagedCredentialResolver({
      credentials: memoryStore([mcpCredential("cred_a", "vlt_a", `https://localhost:${upstream.port}/mcp`, "shared-ca-token")]),
      fetch: async () => { throw new Error("unused"); }, clock: { now: () => new Date() }, log: { warn: () => {} },
    }, createSpecRegistry(builtinSpecs));
    const start = async (sql: SqlClient, pod: string) => {
      const caStore = new SqlEgressCaStore(sql, createNodeSecrets("shared-root").cipherFor("managed.sandbox-egress.ca"));
      const dependencies = {
        caStore, credentials: resolver,
        findSession: async () => ({ vaultIds: ["vlt_a"], archived: false }), claimsHost: () => false,
        log: { info: () => {}, warn: () => {}, error: () => {} }, upstreamCa: upstreamCa.certificatePem,
      };
      const proxy = await startSandboxEgressProxy({
        publicUrl: "http://egress.example:8788", listenHost: "127.0.0.1", listenPort: 0,
        caDir: join(dir, pod), passTtlMs: 60_000,
      }, "shared-root", dependencies);
      const close = proxy.close;
      let closed = false;
      proxy.close = async () => {
        if (closed) return;
        closed = true;
        await close();
      };
      cleanup.push(() => proxy.close());
      return proxy;
    };
    return { dir, sqlA, sqlB, upstream, start };
  }

  it("shares one encrypted CA across independent proxies and restart without a shared local directory", async () => {
    const { dir, sqlA, sqlB, upstream, start } = await replicas();
    const a = await start(sqlA, "pod-a");
    const b = await start(sqlB, "pod-b");
    const caFile = join(dir, "sandbox-trust-from-a.crt");
    await writeFile(caFile, a.settings.caCertificatePem);
    const pass = a.settings.passes.issue({ workspaceId: "ws_a", sessionId: "sesn_a", ttlMs: 60_000 });
    const result = await curl(`https://localhost:${upstream.port}/replica-b`, {
      proxy: `http://openma:${pass}@127.0.0.1:${b.port}`, cacert: caFile,
    });
    expect(result, result.error ?? "").toMatchObject({ status: 200 });
    expect(upstream.seen[0]!.authorization).toBe("Bearer shared-ca-token");
    expect(b.settings.caCertificatePem).toBe(a.settings.caCertificatePem);
    await a.close();
    await b.close();
    const restarted = await start(await createBetterSqlite3SqlClient(join(dir, "shared.sqlite")), "pod-c");
    expect(restarted.settings.caCertificatePem).toBe(a.settings.caCertificatePem);
    const rows = await sqlA.prepare("SELECT value FROM kv_entries").all<{ value: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.value).not.toContain("PRIVATE KEY");
    expect(rows.results![0]!.value).not.toContain("BEGIN CERTIFICATE");
  });

  it.each(["read", "write"] as const)("fails startup on shared CA SQL %s errors even with a valid local CA", async (operation) => {
    const { dir, sqlA, start } = await replicas();
    await loadOrCreateEgressCa(join(dir, "local-ca"));
    if (operation === "read") await sqlA.exec("DROP TABLE kv_entries");
    else await sqlA.exec("CREATE TRIGGER reject_ca_write BEFORE INSERT ON kv_entries BEGIN SELECT RAISE(ABORT, 'ca_write_failed'); END");
    await expect(start(sqlA, "local-ca")).rejects.toThrow();
  });

  it("fails startup when the shared CA cannot be decrypted rather than replacing it", async () => {
    const { dir, sqlA, sqlB, start } = await replicas();
    await start(sqlA, "first");
    const before = await sqlA.prepare("SELECT value FROM kv_entries").first<{ value: string }>();
    const wrongCipher = new SqlEgressCaStore(sqlB, createNodeSecrets("wrong-root").cipherFor("managed.sandbox-egress.ca"));
    await expect(startSandboxEgressProxy({
      publicUrl: "http://egress.example:8788", listenHost: "127.0.0.1", listenPort: 0,
      caDir: join(dir, "other"), passTtlMs: 60_000,
    }, "wrong-root", {
      caStore: wrongCipher, credentials: { outboundTarget: async () => null, forward: async () => { throw new Error("unused"); } },
      findSession: async () => null, claimsHost: () => false, log: { info: () => {}, warn: () => {}, error: () => {} },
    })).rejects.toThrow();
    expect(await sqlA.prepare("SELECT value FROM kv_entries").first<{ value: string }>()).toEqual(before);
  });

  it("rejects corrupt decrypted CA documents without exposing their plaintext", async () => {
    const { sqlA } = await replicas();
    const cipher = createNodeSecrets("shared-root").cipherFor("managed.sandbox-egress.ca");
    const encrypted = await cipher.encrypt("canary-private-material");
    await sqlA.prepare('INSERT INTO kv_entries (tenant_id, "key", value) VALUES (?, ?, ?)')
      .bind("__platform__", "sandbox-egress.ca.v1", encrypted).run();
    const store = new SqlEgressCaStore(sqlA, cipher);
    const error = await store.load().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("canary");
  });

  it("converges concurrent first proxy startups on the single atomically stored CA", async () => {
    const { sqlA, sqlB, start } = await replicas();
    // Audit only successful inserts: both replicas read absence before async
    // key generation, but the losing INSERT must not overwrite the winner.
    await sqlA.exec(`CREATE TABLE ca_insert_audit (created INTEGER);
      CREATE TRIGGER count_ca_insert AFTER INSERT ON kv_entries BEGIN INSERT INTO ca_insert_audit VALUES (1); END`);
    const [a, b] = await Promise.all([start(sqlA, "concurrent-a"), start(sqlB, "concurrent-b")]);
    expect(a.settings.caCertificatePem).toBe(b.settings.caCertificatePem);
    const row = await sqlA.prepare("SELECT COUNT(*) AS count FROM kv_entries").first<{ count: number }>();
    expect(row!.count).toBe(1);
    const inserts = await sqlA.prepare("SELECT COUNT(*) AS count FROM ca_insert_audit").first<{ count: number }>();
    expect(inserts!.count).toBe(1);
    const persisted = await sqlA.prepare("SELECT value FROM kv_entries").first<{ value: string }>();
    await new SqlEgressCaStore(sqlB, createNodeSecrets("shared-root").cipherFor("managed.sandbox-egress.ca"))
      .createIfAbsent({ cert: "must-not-replace", key: "must-not-replace" });
    expect(await sqlA.prepare("SELECT value FROM kv_entries").first<{ value: string }>()).toEqual(persisted);
  });
});

describe("sandbox egress proxy", () => {
  async function fixture(options: {
    records?: (urls: { injected: string; tunneled: string }) => StoredCredential[];
    sessions?: Record<string, EgressSessionRecord>;
    injectedStatus?: (seen: Seen) => number;
    cli?: boolean;
    clock?: { now(): Date };
    tokenResponse?: () => Response;
  } = {}) {
    const dir = await tempDir();
    const upstreamCa = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream-ca")));
    const upstreamCaFile = join(dir, "upstream-ca.crt");
    await writeFile(upstreamCaFile, upstreamCa.certificatePem);
    // "localhost" carries a Vault credential; "127.0.0.1" does not.
    const injected = await startUpstream("localhost", upstreamCa, options.injectedStatus ?? (() => 200));
    const tunneled = await startUpstream("127.0.0.1", upstreamCa, () => 200);
    const urls = {
      injected: `https://localhost:${injected.port}`,
      tunneled: `https://127.0.0.1:${tunneled.port}`,
    };
    const records = options.records?.(urls) ?? [mcpCredential("cred_a", "vlt_a", `${urls.injected}/mcp`, "real-token")];
    if (options.cli) records[0]!.credential.auth = { type: "cap_cli", cliId: "local-cli", token: "real-token" };
    const specs = options.cli ? createSpecRegistry([{
      cli_id: "local-cli", description: "Local HTTPS CLI fixture", endpoints: ["localhost"], inject_mode: "header",
      header: { strip: ["authorization"], set: { name: "authorization", value: "Bearer ${token}" } },
      bootstrap: { env: { LOCAL_CLI_TOKEN: "__cap_managed__" } },
    }]) : createSpecRegistry(builtinSpecs);
    const tokenRequests: string[] = [];
    const resolver = new ManagedCredentialResolver({
      credentials: memoryStore(records),
      fetch: async (_url, init) => {
        tokenRequests.push(String(init?.body));
        return options.tokenResponse?.() ?? Response.json({ access_token: "fresh-token", refresh_token: "refresh-v2" });
      },
      clock: { now: () => new Date() },
      log: { warn: () => {} },
    }, specs);
    const proxy = await startProxy({
      credentials: resolver,
      ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
      upstreamCaPem: upstreamCa.certificatePem,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    return { proxy, injected, tunneled, urls, upstreamCaFile, records, tokenRequests, resolver };
  }

  it("injects the Session's Vault token for a credentialed host; the client only sent the placeholder", async () => {
    const { proxy, injected, urls } = await fixture();
    const result = await curl(`${urls.injected}/v1/user`, {
      proxy: proxy.proxyUrl(),
      cacert: proxy.caFile,
      authorization: "token __cap_managed__",
    });
    expect(result, result.error ?? "").toMatchObject({ status: 200, body: "upstream localhost" });
    expect(injected.seen).toEqual([
      { host: `localhost:${injected.port}`, path: "/v1/user", authorization: "Bearer real-token" },
    ]);
  });

  it("resolves cap_cli placeholders and injects its Vault token through local HTTPS", async () => {
    const { proxy, injected, urls, resolver } = await fixture({ cli: true });
    const placeholders = await resolver.placeholderEnvironment({ workspaceId: "ws_a", sessionId: "sesn_a", vaultIds: ["vlt_a"] });
    expect(placeholders).toEqual({ LOCAL_CLI_TOKEN: "__cap_managed__" });
    const result = await curl(`${urls.injected}/cli`, {
      proxy: proxy.proxyUrl(), cacert: proxy.caFile, authorization: `Bearer ${placeholders.LOCAL_CLI_TOKEN}`,
    });
    expect(result, result.error ?? "").toMatchObject({ status: 200 });
    expect(injected.seen[0]!.authorization).toBe("Bearer real-token");
  });

  it("tunnels hosts without a credential: no interception, headers untouched", async () => {
    const { proxy, tunneled, urls, upstreamCaFile } = await fixture();
    // The client verifies the upstream's own certificate: no MITM happened.
    const result = await curl(`${urls.tunneled}/x`, {
      proxy: proxy.proxyUrl(),
      cacert: upstreamCaFile,
      authorization: "token __cap_managed__",
    });
    expect(result, result.error ?? "").toMatchObject({ status: 200, body: "upstream 127.0.0.1" });
    expect(tunneled.seen).toEqual([{ host: expect.any(String), path: "/x", authorization: "token __cap_managed__" }]);
  });

  it("selects only within the Session's Vaults", async () => {
    const { proxy, injected, urls, upstreamCaFile } = await fixture({
      records: (u) => [mcpCredential("cred_b", "vlt_b", `${u.injected}/mcp`, "other-vault-token")],
      sessions: { "ws_a/sesn_a": { vaultIds: ["vlt_a"], archived: false } },
    });
    // The credential lives in vlt_b, outside the Session: a blind tunnel,
    // verified against the upstream's own certificate.
    const result = await curl(`${urls.injected}/`, {
      proxy: proxy.proxyUrl(),
      cacert: upstreamCaFile,
      authorization: "token __cap_managed__",
    });
    expect(result, result.error ?? "").toMatchObject({ status: 200 });
    expect(injected.seen).toEqual([{ host: expect.any(String), path: "/", authorization: "token __cap_managed__" }]);
  });

  it("refreshes once after a 401 and retries with the new token", async () => {
    const { proxy, injected, urls, tokenRequests, records } = await fixture({
      injectedStatus: (seen) => (seen.authorization === "Bearer fresh-token" ? 200 : 401),
    });
    const result = await curl(`${urls.injected}/v1/user`, { proxy: proxy.proxyUrl(), cacert: proxy.caFile });
    expect(result, result.error ?? "").toMatchObject({ status: 200 });
    expect(injected.seen.map((s) => s.authorization)).toEqual(["Bearer real-token", "Bearer fresh-token"]);
    expect(tokenRequests).toHaveLength(1);
    expect(records[0]!.credential.auth).toMatchObject({ accessToken: "fresh-token" });
  });

  it("does not refresh or replay an upstream 403", async () => {
    const { proxy, injected, urls, tokenRequests } = await fixture({ injectedStatus: () => 403 });
    const result = await curl(`${urls.injected}/forbidden`, { proxy: proxy.proxyUrl(), cacert: proxy.caFile });
    expect(result, result.error ?? "").toMatchObject({ status: 403 });
    expect(injected.seen).toHaveLength(1);
    expect(tokenRequests).toEqual([]);
  });

  it("keeps a failed 401 refresh to one upstream request", async () => {
    const { proxy, injected, urls, tokenRequests } = await fixture({ injectedStatus: () => 401, tokenResponse: () => new Response("rejected", { status: 400 }) });
    const result = await curl(`${urls.injected}/expired`, { proxy: proxy.proxyUrl(), cacert: proxy.caFile });
    expect(result, result.error ?? "").toMatchObject({ status: 401 });
    expect(injected.seen).toHaveLength(1);
    expect(tokenRequests).toHaveLength(1);
  });

  it("replays the entire binary POST body after a 401 refresh", async () => {
    const { proxy, injected, urls, tokenRequests } = await fixture({
      injectedStatus: (seen) => seen.authorization === "Bearer fresh-token" ? 200 : 401,
    });
    const body = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from("payload-".repeat(20_000))]);
    const bodyFile = join(await tempDir(), "request.bin");
    await writeFile(bodyFile, body);
    const result = await curl(`${urls.injected}/upload?part=1`, {
      proxy: proxy.proxyUrl(), cacert: proxy.caFile, bodyFile,
    });
    expect(result, result.error ?? "").toMatchObject({ status: 200 });
    expect(injected.seen).toHaveLength(2);
    for (const request of injected.seen) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/upload?part=1");
      expect(request.body).toEqual(body);
    }
    expect(injected.seen.map((s) => s.authorization)).toEqual(["Bearer real-token", "Bearer fresh-token"]);
    expect(tokenRequests).toHaveLength(1);
  });

  it.each(["vault removed", "archived", "expired"] as const)("revalidates a keepalive MITM request after the Session is %s", async (change) => {
    let now = Date.now();
    const sessions = { "ws_a/sesn_a": { vaultIds: ["vlt_a"], archived: false } };
    const { proxy, injected } = await fixture({ sessions, clock: { now: () => new Date(now) } });
    const get = await keepAliveClient(proxy, `localhost:${injected.port}`);
    expect(await get()).toMatch(/^HTTP\/1.1 200 /u);
    expect(injected.seen[0]!.authorization).toBe("Bearer real-token");
    if (change === "vault removed") sessions["ws_a/sesn_a"] = { vaultIds: [], archived: false };
    else if (change === "archived") sessions["ws_a/sesn_a"] = { vaultIds: ["vlt_a"], archived: true };
    else now += 60_001;
    const response = await get();
    if (change === "vault removed") {
      expect(response).toMatch(/^HTTP\/1.1 200 /u);
      expect(injected.seen).toHaveLength(2);
      expect(injected.seen[1]!.authorization).toBeUndefined();
    } else {
      expect(response).toMatch(change === "archived" ? /^HTTP\/1.1 403 /u : /^HTTP\/1.1 407 /u);
      expect(injected.seen).toHaveLength(1);
    }
  });

  it("never logs a credential rejected as an invalid HTTP header", async () => {
    const { proxy, injected, urls } = await fixture({
      records: (u) => [mcpCredential("cred_a", "vlt_a", `${u.injected}/mcp`, "canary-real-token\r\ninvalid")],
    });
    const result = await curl(`${urls.injected}/`, { proxy: proxy.proxyUrl(), cacert: proxy.caFile });
    expect(result).toMatchObject({ status: 502 });
    expect(injected.seen).toHaveLength(0);
    expect(proxy.logs.some((entry) => entry.level === "error")).toBe(true);
    expect(JSON.stringify(proxy.logs)).not.toContain("canary-real-token");
    expect(result.body).not.toContain("canary-real-token");
  });

  it("answers 502 when the credential store fails, instead of forwarding without the credential", async () => {
    const dir = await tempDir();
    const upstreamCa = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream-ca")));
    const proxy = await startProxy({
      credentials: {
        outboundTarget: async () => { throw new Error("database unavailable"); },
        forward: async () => { throw new Error("unused"); },
      },
      upstreamCaPem: upstreamCa.certificatePem,
    });
    expect(await rawConnect(proxy.port, "example.test:443", basic(proxy.pass()))).toBe("HTTP/1.1 502 Bad Gateway");
    expect(proxy.logs.some((l) => l.level === "error" && l.fields.op === "sandbox_egress.failed")).toBe(true);
  });

  it("is never an open proxy: without a valid pass nothing is resolved or dialed", async () => {
    const dir = await tempDir();
    const upstreamCa = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream-ca")));
    const proxy = await startProxy({
      credentials: {
        outboundTarget: async () => { throw new Error("must not be consulted"); },
        forward: async () => { throw new Error("unused"); },
      },
      upstreamCaPem: upstreamCa.certificatePem,
    });
    for (const authority of ["example.com:443", "example.com:22", "169.254.169.254:80"]) {
      expect(await rawConnect(proxy.port, authority)).toBe("HTTP/1.1 407 Proxy Authentication Required");
    }
    expect(await rawConnect(proxy.port, "example.com:443", basic("forged.pass"))).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(await rawConnect(proxy.port, "example.com:443", "Bearer whatever")).toBe("HTTP/1.1 407 Proxy Authentication Required");
    // Plain-HTTP proxying is refused the same way.
    const plain = await curl("http://example.com/", { proxy: `http://127.0.0.1:${proxy.port}`, cacert: proxy.caFile });
    expect(plain.status).toBe(407);
  });

  it("refuses expired, archived, unknown and cross-workspace passes", async () => {
    const { proxy } = await fixture({
      sessions: {
        "ws_a/sesn_a": { vaultIds: ["vlt_a"], archived: false },
        "ws_a/sesn_old": { vaultIds: ["vlt_a"], archived: true },
      },
    });
    const expired = createEgressPassAuthority("root", clockAt(0)).issue({ workspaceId: "ws_a", sessionId: "sesn_a", ttlMs: 1 });
    expect(await rawConnect(proxy.port, "example.test:443", basic(expired))).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(await rawConnect(proxy.port, "example.test:443", basic(proxy.pass("sesn_old")))).toBe("HTTP/1.1 403 Forbidden");
    expect(await rawConnect(proxy.port, "example.test:443", basic(proxy.pass("sesn_gone")))).toBe("HTTP/1.1 403 Forbidden");
    // sesn_a exists only in ws_a: a pass naming it under ws_b reaches nothing.
    expect(await rawConnect(proxy.port, "example.test:443", basic(proxy.pass("sesn_a", "ws_b")))).toBe("HTTP/1.1 403 Forbidden");
  });

  it("tunnels local destinations with the default proxy settings", async () => {
    const dir = await tempDir();
    const upstreamCa = await createEgressCertificateAuthority(await loadOrCreateEgressCa(join(dir, "upstream-ca")));
    const upstream = await startUpstream("127.0.0.1", upstreamCa, () => 200);
    const proxy = await startProxy({
      credentials: { outboundTarget: async () => null, forward: async () => { throw new Error("unused"); } },
      upstreamCaPem: upstreamCa.certificatePem,
    });
    expect(await rawConnect(proxy.port, `127.0.0.1:${upstream.port}`, basic(proxy.pass())))
      .toBe("HTTP/1.1 200 Connection Established");
  });

  it("does not throttle a valid pass after other authentication failures", async () => {
    const { proxy, tunneled } = await fixture();
    for (let i = 0; i < 25; i++) {
      expect(await rawConnect(proxy.port, "example.test:443", basic("invalid")))
        .toBe("HTTP/1.1 407 Proxy Authentication Required");
    }
    expect(await rawConnect(proxy.port, `127.0.0.1:${tunneled.port}`, basic(proxy.pass())))
      .toBe("HTTP/1.1 200 Connection Established");
  });

  it("keeps concurrent tunnels for the same Session usable", async () => {
    const { proxy, tunneled } = await fixture();
    const pass = basic(proxy.pass());
    for (let i = 0; i < 70; i++) {
      const tunnel = await openTunnel(proxy.port, `127.0.0.1:${tunneled.port}`, pass);
      expect(tunnel.status).toBe("HTTP/1.1 200 Connection Established");
    }
  });

  it("persists one CA per directory", async () => {
    const dir = await tempDir();
    const first = await loadOrCreateEgressCa(join(dir, "ca"));
    const second = await loadOrCreateEgressCa(join(dir, "ca"));
    expect(second).toEqual(first);
    expect(await readFile(join(dir, "ca", "ca.crt"), "utf8")).toBe(first.cert);
  });
});
