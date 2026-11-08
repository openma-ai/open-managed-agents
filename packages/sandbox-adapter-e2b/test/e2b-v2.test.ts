import { describe, expect, it } from "vitest";
import { RetryableSandboxError, SandboxGoneError } from "@open-managed-agents/sandbox";
import { createR2TemporaryCredentials } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import { SandboxAssemblyError } from "@open-managed-agents/sandbox-port-kit/ports";
import { compileFirewall } from "@open-managed-agents/sandbox-port-kit/firewall";
import { createE2BV2Adapter, e2bNetwork, type E2BV2Module } from "../src/v2";

const PARENT_SECRET = "parent-secret-must-stay-in-the-control-plane";
const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "t", expiresAt: "2030-01-01T00:00:00.000Z" };
const outputs = { bindingId: "out", mountPath: "/mnt/session/outputs" as const };
const signal = new AbortController().signal;
const plan = { from: { image: "oma-template" }, egress: null, stores: [], outputs, idleMs: 60_000, labels: { workspaceId: "ws", sessionId: "sess" } };

function apiError(name: string, statusCode?: number): Error {
  const error = new Error(name) as Error & { statusCode?: number };
  error.name = name;
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

interface Call { cmd: string; opts: Record<string, unknown> }

/** Just enough shell for the generic file sync over the fake filesystem. */
function shellOver(files: Map<string, Uint8Array>) {
  const quoted = (cmd: string) => [...cmd.matchAll(/'([^']*)'/gu)].map((m) => m[1]!);
  return (cmd: string) => {
    const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
    if (cmd === "id -u") return ok("1000\n");
    if (cmd.includes("EGRESS_READY:")) return ok(`EGRESS_READY:${JSON.stringify({ pid: 42, port: 18080, caFile: "/workspace/.oma-egress/ca.crt", caBundleFile: "/workspace/.oma-egress/ca-bundle.crt" })}\n`);
    if (cmd.includes("EGRESS_DIR:")) return ok("EGRESS_DIR:/workspace/.oma-egress\n");
    if (cmd.includes("find . -type f")) {
      const root = cmd.includes("cd /mnt/session/outputs") ? "/mnt/session/outputs" : quoted(cmd)[0]!;
      const names = [...files.keys()].filter((p) => p.startsWith(`${root}/`)).map((p) => `./${p.slice(root.length + 1)}`);
      return ok(names.length ? btoa(names.join("\0") + "\0") : "");
    }
    if (cmd.startsWith("if [ -f ")) return ok(files.has(quoted(cmd)[0]!) ? "1" : "0");
    if (cmd.includes("rm -rf -- ")) {
      const root = quoted(cmd).at(-2)!;
      for (const key of [...files.keys()]) if (key.startsWith(`${root}/`)) files.delete(key);
    }
    return ok();
  };
}


function fakeSdk() {
  const calls = { create: [] as Array<[string, Record<string, unknown>]>, commands: [] as Call[], kill: [] as string[], deleted: [] as string[], network: [] as unknown[], timeouts: [] as number[], paused: 0, listQueries: [] as unknown[] };
  const files = new Map<string, Uint8Array>();
  const shell = shellOver(files);
  const errors: { create?: Error; connect?: Error; setTimeout?: Error; snapshot?: Error; kill?: Error; command?: Error; verifyMount?: { exitCode: number; stderr: string } } = {};
  const sandbox = (id: string) => ({
    sandboxId: id,
    commands: {
      async run(cmd: string, opts: Record<string, unknown> = {}) {
        if (errors.command) throw errors.command;
        calls.commands.push({ cmd, opts });
        if (errors.verifyMount && cmd.startsWith("mountpoint -q ")) return { stdout: "", ...errors.verifyMount };
        return shell(cmd.replace(/^cd \/workspace 2>\/dev\/null; /u, ""));
      },
    },
    files: {
      async read(path: string) {
        const bytes = files.get(path);
        if (bytes === undefined) throw apiError("FileNotFoundError", 404);
        return bytes as unknown as string;
      },
      async write(path: string, data: string | Uint8Array) { files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data); },
    },
    async kill() { return true; },
    async setTimeout(ms: number) { if (errors.setTimeout) throw errors.setTimeout; calls.timeouts.push(ms); },
    async pause() { calls.paused += 1; return true; },
    async createSnapshot(opts?: { name?: string }) { if (errors.snapshot) throw errors.snapshot; return { snapshotId: `snap-${opts?.name ?? "anon"}`, names: [] }; },
    async updateNetwork(network: unknown) { calls.network.push(network); },
  });
  const sdk: E2BV2Module = {
    Sandbox: {
      async create(template: string, args: Record<string, unknown> = {}) {
        if (errors.create) throw errors.create;
        calls.create.push([template, args]);
        return sandbox(`sbx-${calls.create.length}`);
      },
      async connect(id: string) { if (errors.connect) throw errors.connect; return sandbox(id); },
      async kill(id: string) { if (errors.kill) throw errors.kill; calls.kill.push(id); return true; },
      async deleteSnapshot(id: string) { calls.deleted.push(id); return true; },
      list(opts?: { query?: unknown }) {
        calls.listQueries.push(opts?.query);
        let done = false;
        return {
          get hasNext() { return !done; },
          async nextItems() {
            done = true;
            return [
              { sandboxId: "a", metadata: { workspaceId: "ws", sessionId: "s1" }, startedAt: new Date("2026-01-01T00:00:00Z") },
              { sandboxId: "b", metadata: {}, startedAt: "2026-01-01T00:00:00Z" },
            ];
          },
        };
      },
    } as unknown as E2BV2Module["Sandbox"],
  };
  return { sdk, calls, files, errors };
}

function adapter(fake: ReturnType<typeof fakeSdk>, extra: Partial<Parameters<typeof createE2BV2Adapter>[0]> = {}) {
  return createE2BV2Adapter({ sdk: fake.sdk, connection: { apiKey: "e2b-key" }, leaseMs: 120_000, maxLifetimeMs: 3_600_000, user: "root", ...extra });
}

describe("E2B v2 lifecycle", () => {
  it("acquires with session labels, the lease timeout and pause-on-timeout, then runs setup as root", async () => {
    const fake = fakeSdk();
    const lifecycle = adapter(fake, { setup: "command -v s3fs || apt-get install -y s3fs" }).lifecycle;
    expect(lifecycle.handle).toBe("changes");
    const acquired = await lifecycle.acquire({ scope, plan, signal });
    expect(acquired).toMatchObject({ handle: { provider: "e2b", runtimeId: "sbx-1" } });
    const [template, args] = fake.calls.create[0]!;
    expect(template).toBe("oma-template");
    expect(args).toMatchObject({ apiKey: "e2b-key", metadata: { workspaceId: "ws", sessionId: "sess" }, timeoutMs: 120_000, lifecycle: { onTimeout: { action: "pause", keepMemory: true }, autoResume: true } });
    expect(fake.calls.commands.find((c) => c.cmd.includes("s3fs"))?.opts.user).toBe("root");
  });

  it("requires maxLifetimeMs at assembly and keeps every plan's idle window below it (design §0.0 rule 11)", async () => {
    const fake = fakeSdk();
    expect(adapter(fake).lifecycle.maxLifetimeMs).toBe(3_600_000);
    const { maxLifetimeMs: _omit, ...withoutCap } = { sdk: fake.sdk, connection: { apiKey: "e2b-key" }, leaseMs: 120_000, maxLifetimeMs: 1 };
    expect(() => createE2BV2Adapter(withoutCap as never)).toThrow(SandboxAssemblyError);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600000"]) {
      expect(() => adapter(fake, { maxLifetimeMs: bad as never })).toThrow(/maxLifetimeMs is required/);
    }
    await expect(adapter(fake, { maxLifetimeMs: 60_000 }).lifecycle.acquire({ scope, plan, signal })).rejects.toThrow(/maxLifetimeMs \(60000\) must exceed the plan idleMs/);
    expect(fake.calls.create).toEqual([]);
  });

  it("refuses a lease that does not outlive the plan idle window", async () => {
    const fake = fakeSdk();
    await expect(adapter(fake, { leaseMs: 60_000 }).lifecycle.acquire({ scope, plan, signal })).rejects.toThrow(/must exceed/);
  });

  it("maps not-found to gone and throttling to RetryableSandboxError", async () => {
    const fake = fakeSdk();
    const lifecycle = adapter(fake).lifecycle;
    fake.errors.create = apiError("SandboxError", 404);
    expect(await lifecycle.acquire({ scope, plan: { ...plan, from: { template: { provider: "e2b", ref: "expired" } } }, signal })).toBe("gone");
    fake.errors.create = apiError("RateLimitError", 429);
    await expect(lifecycle.acquire({ scope, plan, signal })).rejects.toBeInstanceOf(RetryableSandboxError);
    fake.errors.create = apiError("ServiceBusyError", 503);
    await expect(lifecycle.acquire({ scope, plan, signal })).rejects.toMatchObject({ retryAfterMs: 1_000 });
    fake.errors.connect = apiError("SandboxNotFoundError");
    expect(await lifecycle.attach({ scope, handle: { provider: "e2b", runtimeId: "missing" }, signal })).toBe("gone");
    delete fake.errors.create;
    const acquired = await lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    fake.errors.setTimeout = apiError("SandboxNotFoundError");
    expect(await lifecycle.keepAlive(acquired)).toBe("gone");
    fake.errors.snapshot = apiError("SandboxNotFoundError");
    await expect(lifecycle.checkpoint({ scope, ...acquired, signal })).rejects.toBeInstanceOf(SandboxGoneError);
  });

  it("pauses in place, resumes by connect, checkpoints into snapshots and cleans up", async () => {
    const fake = fakeSdk();
    const lifecycle = adapter(fake).lifecycle;
    const acquired = await lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    expect(await lifecycle.keepAlive(acquired)).toBe("alive");
    expect(fake.calls.timeouts).toEqual([120_000]);
    const paused = await lifecycle.pause({ scope, ...acquired, signal });
    expect(paused).toEqual({ provider: "e2b", ref: "sbx-1", metadata: { kind: "self" } });
    expect(fake.calls.paused).toBe(1);
    expect(await lifecycle.resume({ scope, ref: paused, plan, signal })).toMatchObject({ handle: { runtimeId: "sbx-1" } });
    const snapshot = await lifecycle.checkpoint({ scope, ...acquired, signal });
    const restored = await lifecycle.resume({ scope, ref: snapshot, plan, signal });
    expect(fake.calls.create.at(-1)![0]).toBe(snapshot.ref);
    expect(restored).toMatchObject({ handle: { runtimeId: "sbx-2" } });
    const template = await lifecycle.snapshotTemplate({ ...acquired, signal });
    expect(template).toEqual({ provider: "e2b", ref: "snap-oma-sbx-1" });
    await lifecycle.discard({ scope, ref: paused });
    await lifecycle.discard({ scope, ref: template });
    expect(fake.calls.deleted).toEqual(["snap-oma-sbx-1"]);
    await lifecycle.release({ scope, handle: acquired.handle });
    fake.errors.kill = apiError("SandboxNotFoundError");
    await expect(lifecycle.release({ scope, handle: acquired.handle })).resolves.toBeUndefined();
    expect(fake.calls.kill).toEqual(["sbx-1"]);
  });

  it("lists labelled sandboxes for orphan reaping", async () => {
    const fake = fakeSdk();
    expect(await adapter(fake).lifecycle.list({ labels: { workspaceId: "ws" }, signal })).toEqual([
      { handle: { provider: "e2b", runtimeId: "a" }, labels: { workspaceId: "ws", sessionId: "s1" }, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(fake.calls.listQueries).toEqual([{ metadata: { workspaceId: "ws" }, state: ["running", "paused"] }]);
  });

  it("lists without a metadata filter when no label is given (the SDK sends metadata= and E2B answers 400)", async () => {
    const fake = fakeSdk();
    expect(await adapter(fake).lifecycle.list({ labels: {}, signal })).toHaveLength(1);
    expect(fake.calls.listQueries).toEqual([{ state: ["running", "paused"] }]);
  });
});

describe("E2B v2 firewall", () => {
  it("denies metadata in open mode and turns a limited policy into an allowlist with platform channels", () => {
    expect(e2bNetwork(compileFirewall(null, { gateway: { hosts: [] }, channels: [] }), [])).toEqual({
      allowOut: [],
      denyOut: ["169.254.169.254/32", "100.100.100.200/32"],
    });
    const limited = compileFirewall({
      scope: { workspaceId: "ws", sessionId: "sess", generation: 1 },
      networking: { type: "limited", hosts: ["api.github.com"], packageSources: [], mcpHosts: [] },
      substitutions: [],
    }, { gateway: { hosts: [] }, channels: [] });
    expect(e2bNetwork(limited, ["acct.r2.cloudflarestorage.com"])).toEqual({
      allowOut: ["api.github.com", "acct.r2.cloudflarestorage.com"],
      denyOut: ["0.0.0.0/0"],
    });
  });
});

const gatewayDeps = { gateway: { endpoint: { url: "https://control.example" }, issueToken: async () => "pass", authenticate: async () => null, handle: async () => new Response(null, { status: 404 }) } };

describe("E2B v2 storage", () => {
  const MEMORY_SECRET = "memory-parent-secret-stays-in-the-control-plane";
  const FILES_SECRET = "files-parent-secret-stays-in-the-control-plane";
  const memoryParent = { accountId: "acct", endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "memory", accessKeyId: "memory-parent-id", secretAccessKey: MEMORY_SECRET };
  const filesParent = { accountId: "acct", endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "files", accessKeyId: "files-parent-id", secretAccessKey: FILES_SECRET };
  const objectStorage = (ttlSeconds?: number) => ({
    memory: createR2TemporaryCredentials(memoryParent),
    outputs: createR2TemporaryCredentials(filesParent),
    outputsPrefix: (s: { workspaceId: string; sessionId: string }) => `t/${s.workspaceId}/session-outputs/${s.sessionId}/`,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  });
  const claimsOf = (token: string) => {
    const payload = atob(token).slice(4).split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(payload.padEnd(4 * Math.ceil(payload.length / 4), "=")));
  };
  const stores = [{ storeName: "notes", storeId: "store_rw", readOnly: false }, { storeName: "docs", storeId: "store_ro", readOnly: true }];

  it("native: mounts Memory and outputs from their own buckets; parent keys never reach the sandbox", async () => {
    const fake = fakeSdk();
    const kit = adapter(fake, { objectStorage: objectStorage(900) });
    const { ports } = createSandboxPorts(kit, { storage: { memories: () => { throw new Error("sync not used"); }, authorize: async () => true, outputs: { read: () => { throw new Error("sync not used"); }, publish: async () => { throw new Error("sync not used"); } } }, egress: gatewayDeps });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    await ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores, outputs, signal });
    const mounts = fake.calls.commands.filter((c) => c.cmd.includes("rclone mount "));
    expect(mounts).toHaveLength(3);
    // Every mount is verified right after it.
    const verifies = fake.calls.commands.filter((c) => c.cmd.startsWith("mountpoint -q "));
    expect(verifies.map((c) => /^mountpoint -q '([^']+)'/u.exec(c.cmd)![1])).toEqual(["/mnt/session/outputs", "/mnt/memory/notes", "/mnt/memory/docs"]);
    for (const call of verifies) expect(call.cmd).toContain("ls -A");
    for (const call of fake.calls.commands) {
      for (const secret of [MEMORY_SECRET, FILES_SECRET]) {
        expect(call.cmd).not.toContain(secret);
        expect(JSON.stringify(call.opts)).not.toContain(secret);
      }
    }
    for (const [path, bytes] of fake.files) {
      expect(path).not.toMatch(/passwd|credentials/u);
      expect(new TextDecoder().decode(bytes)).not.toMatch(new RegExp(`${MEMORY_SECRET}|${FILES_SECRET}`, "u"));
    }
    const [out, rw, ro] = mounts;
    // Remotes are rooted at the prefix and never check the bucket (no bucket-root probe).
    expect(out!.cmd).toContain("rclone mount ':s3:files/t/ws/session-outputs/sess' '/mnt/session/outputs'");
    expect(rw!.cmd).toContain("rclone mount ':s3:memory/store_rw' '/mnt/memory/notes'");
    expect(ro!.cmd).toContain("'--read-only'");
    expect(rw!.cmd).not.toContain("--read-only");
    for (const call of mounts) {
      expect(call.opts.user).toBe("root");
      expect(call.cmd).toContain("'--s3-no-check-bucket'");
      expect(call.cmd).not.toMatch(/AWS_|RCLONE_|session_token|passwd/u);
    }
    const envs = (call: (typeof mounts)[number]) => call.opts.envs as Record<string, string>;
    expect(envs(out!).RCLONE_S3_ACCESS_KEY_ID).toBe("files-parent-id");
    expect(envs(rw!).RCLONE_S3_ACCESS_KEY_ID).toBe("memory-parent-id");
    expect(envs(rw!)).toMatchObject({ RCLONE_S3_PROVIDER: "Cloudflare", RCLONE_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", RCLONE_S3_REGION: "auto" });
    expect(claimsOf(envs(out!).RCLONE_S3_SESSION_TOKEN!)).toMatchObject({ bucket: "files", scope: "object-read-write", paths: { prefixPaths: ["t/ws/session-outputs/sess/"] } });
    expect(claimsOf(envs(rw!).RCLONE_S3_SESSION_TOKEN!)).toMatchObject({ bucket: "memory", scope: "object-read-write", paths: { prefixPaths: ["store_rw/"] } });
    const ro_claims = claimsOf(envs(ro!).RCLONE_S3_SESSION_TOKEN!);
    expect(ro_claims).toMatchObject({ bucket: "memory", scope: "object-read-only", paths: { prefixPaths: ["store_ro/"] } });
    expect(ro_claims.exp - ro_claims.iat).toBe(900);
    // Idempotent while the credentials are fresh; turn_end publishes nothing (mounts are live).
    await ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores, outputs, signal });
    await ports.storage.sync({ runtime: acquired.runtime, scope, fence, stores, outputs, reason: "turn_end", signal });
    expect(fake.calls.commands.filter((c) => c.cmd.includes("rclone mount "))).toHaveLength(3);
    await ports.storage.detach({ runtime: acquired.runtime, scope });
    expect(fake.calls.commands.filter((c) => c.cmd.startsWith("umount"))).toHaveLength(3);
  });

  it("native: storage commands do not inherit the Session's relay env (rclone's S3 SDK rejects AWS_CA_BUNDLE)", async () => {
    const fake = fakeSdk();
    const kit = adapter(fake, { objectStorage: objectStorage() });
    const { ports } = createSandboxPorts(kit, { storage: {} as never, egress: gatewayDeps });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    // Execution order (design §0.0 rule 7): egress.attach, then storage.attach.
    const policy = {
      scope: { workspaceId: "ws", sessionId: "sess", generation: 1 },
      networking: { type: "unrestricted" as const },
      substitutions: [{ credentialId: "vault", envName: "API_TOKEN", placeholder: "oma_vault_x", hosts: [], inject: { header: true, body: false } }],
    };
    await ports.egress.attach({ runtime: acquired.runtime, scope, fence, policy, signal });
    await kit.native!.storage!({} as never).attach({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, signal });
    const storageCalls = fake.calls.commands.filter((c) => c.cmd.includes("rclone mount ") || c.cmd.startsWith("mountpoint -q ") || c.cmd.startsWith("mkdir -p /mnt/session/outputs"));
    expect(storageCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of storageCalls) {
      const envs = (call.opts.envs ?? {}) as Record<string, string>;
      for (const name of ["AWS_CA_BUNDLE", "SSL_CERT_FILE", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "API_TOKEN"]) expect(envs).not.toHaveProperty(name);
    }
    // The agent's own commands still see the relay env.
    await acquired.runtime.run("env");
    expect(fake.calls.commands.at(-1)!.opts.envs).toMatchObject({ API_TOKEN: "oma_vault_x", HTTPS_PROXY: "http://127.0.0.1:18080" });
  });

  it("native: re-mints and remounts once less than half the credential lifetime is left", async () => {
    const fake = fakeSdk();
    let issued = 0;
    const shortLived = { async issue(input: { prefix: string; access: "read_only" | "read_write"; ttlSeconds: number }) {
      issued += 1;
      return { ...await createR2TemporaryCredentials(memoryParent).issue(input), expiresAt: Date.now() + 1_000 };
    } };
    const kit = adapter(fake, { objectStorage: { ...objectStorage(3_600), memory: shortLived } });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    const storage = kit.native!.storage!({} as never);
    await storage.attach({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, signal });
    expect(issued).toBe(1);
    await storage.sync({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, reason: "interval", signal });
    expect(issued).toBe(2);
    const remounts = fake.calls.commands.filter((c) => c.cmd.includes("':s3:memory/store_rw'"));
    expect(remounts).toHaveLength(2);
    expect(remounts[1]!.cmd).toMatch(/^\(mountpoint -q '\/mnt\/memory\/notes' && \(umount/u);
    // The outputs mount has a full hour left: not remounted.
    expect(fake.calls.commands.filter((c) => c.cmd.includes("rclone mount ':s3:files/t/ws/session-outputs/sess'"))).toHaveLength(1);
  });

  it("native: a mount process that exits 0 without a mountpoint fails attach (Memory and outputs)", async () => {
    for (const [stores_, expected] of [[[], "/mnt/session/outputs"], [[stores[0]!], "/mnt/session/outputs"]] as const) {
      const fake = fakeSdk();
      const kit = adapter(fake, { objectStorage: objectStorage() });
      const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
      if (acquired === "gone") throw new Error("unexpected");
      const storage = kit.native!.storage!({} as never);
      // rclone (or s3fs) daemonizes and exits 0; the FUSE process then dies.
      fake.errors.verifyMount = { exitCode: 90, stderr: "not a mountpoint" };
      await expect(storage.attach({ runtime: acquired.runtime, scope, fence, stores: [...stores_], outputs, signal }))
        .rejects.toThrow(`E2B storage mount ${expected} is not usable (exit 90): not a mountpoint`);
      expect(fake.calls.commands.filter((c) => c.cmd.includes("rclone mount "))).toHaveLength(1);
    }
    // Outputs mounted, the Memory mount alone fails its listing (credential rejected through FUSE).
    const fake = fakeSdk();
    const kit = adapter(fake, { objectStorage: objectStorage() });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    const storage = kit.native!.storage!({} as never);
    const run = acquired.runtime.run.bind(acquired.runtime);
    (acquired.runtime as unknown as { run: typeof run }).run = async (cmd, opts) =>
      cmd.startsWith("mountpoint -q '/mnt/memory/notes'") ? { exitCode: 2, stdout: "", stderr: "ls: reading directory: Input/output error" } : run(cmd, opts);
    await expect(storage.attach({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, signal }))
      .rejects.toThrow("E2B storage mount /mnt/memory/notes is not usable (exit 2): ls: reading directory: Input/output error");
  });

  it("without objectStorage there is no native storage: Memory is copied in and written back, outputs upload at turn_end", async () => {
    const fake = fakeSdk();
    const kit = adapter(fake);
    expect(kit.native).toBeUndefined();
    const memory = new Map([["/a.md", "one"]]);
    const sha = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
    const memories = {
      async list() { return Promise.all([...memory].map(async ([path, content]) => ({ id: path, path, contentSha256: await sha(content), content }))); },
      async create(input: { path: string; content: string }) { memory.set(input.path, input.content); return { type: "applied" as const }; },
      async update(input: { path: string; content: string }) { memory.set(input.path, input.content); return { type: "applied" as const }; },
      async delete(input: { memoryId: string }) { memory.delete(input.memoryId); return { type: "applied" as const }; },
    };
    const published: string[] = [];
    let failPublish = false;
    const { ports } = createSandboxPorts(kit, {
      storage: {
        memories: () => memories,
        authorize: async () => true,
        outputs: { async *read() {}, async publish(input) {
          if (failPublish) throw new Error("R2 put failed");
          for await (const [path] of input.files) published.push(path);
        } },
      },
      egress: gatewayDeps,
    });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    await ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, signal });
    expect(new TextDecoder().decode(fake.files.get("/mnt/memory/notes/a.md"))).toBe("one");
    expect(fake.calls.commands.some((c) => c.cmd.includes("rclone mount "))).toBe(false);
    fake.files.set("/mnt/memory/notes/b.md", new TextEncoder().encode("two"));
    fake.files.set("/mnt/session/outputs/report.md", new TextEncoder().encode("# done"));
    await ports.storage.sync({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, reason: "interval", signal });
    expect(memory.get("/b.md")).toBe("two");
    expect(published).toEqual([]);
    await ports.storage.sync({ runtime: acquired.runtime, scope, fence, stores: [stores[0]!], outputs, reason: "turn_end", signal });
    expect(published).toEqual(["report.md"]);
    failPublish = true;
    await expect(ports.storage.sync({ runtime: acquired.runtime, scope, fence, stores: [], outputs, reason: "turn_end", signal })).rejects.toThrow("R2 put failed");
  });
});

describe("E2B v2 egress (generic forwarder over the E2B vendor)", () => {
  it("installs the relay against the gateway with a pass, sets placeholders and allows only the gateway beyond the policy", async () => {
    const fake = fakeSdk();
    const kit = adapter(fake);
    const issued: string[] = [];
    const { ports } = createSandboxPorts(kit, {
      storage: {} as never,
      egress: { gateway: { ...gatewayDeps.gateway, endpoint: { url: "https://control.example" }, issueToken: async ({ scope: s }) => { issued.push(s.sessionId); return "relay-pass"; } } },
    });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    const policy = {
      scope: { workspaceId: "ws", sessionId: "sess", generation: 1 },
      networking: { type: "limited" as const, hosts: ["pypi.org"], packageSources: [], mcpHosts: [] },
      substitutions: [{ credentialId: "cap_cli:GITHUB_TOKEN", envName: "GITHUB_TOKEN", placeholder: "__cap_managed__", hosts: [], inject: { header: true, body: false } }],
    };
    await ports.egress.attach({ runtime: acquired.runtime, scope, fence, policy, signal });
    expect(issued).toEqual(["sess"]);
    expect(fake.calls.network.at(-1)).toEqual({ allowOut: ["control.example", "pypi.org"], denyOut: ["0.0.0.0/0"] });
    expect(new TextDecoder().decode(fake.files.get("/workspace/.oma-egress/relay.cjs")).length).toBeGreaterThan(100_000);
    const binding = JSON.parse(new TextDecoder().decode(fake.files.get("/workspace/.oma-egress/binding.next.json")));
    expect(binding).toEqual({ endpoint: "https://control.example", pass: "relay-pass", directory: "/workspace/.oma-egress" });
    // Every generic exec runs from /workspace, where the installer's relative paths live.
    expect(fake.calls.commands.filter((c) => c.cmd.includes(".oma-egress")).every((c) => c.cmd.startsWith("cd /workspace 2>/dev/null; "))).toBe(true);
    const run = await acquired.runtime.run("env");
    void run;
    const envs = fake.calls.commands.at(-1)!.opts.envs as Record<string, string>;
    expect(envs).toMatchObject({ GITHUB_TOKEN: "__cap_managed__", HTTPS_PROXY: "http://127.0.0.1:18080", SSL_CERT_FILE: "/workspace/.oma-egress/ca-bundle.crt" });
    await ports.egress.revoke({ runtime: acquired.runtime, scope, fence, reason: "completed" });
    await acquired.runtime.run("env");
    expect((fake.calls.commands.at(-1)!.opts.envs as Record<string, string>).HTTPS_PROXY).toBe("");
  });

  it("installs no relay without substitutions", async () => {
    const fake = fakeSdk();
    const kit = adapter(fake);
    const { ports } = createSandboxPorts(kit, { storage: {} as never, egress: gatewayDeps });
    const acquired = await kit.lifecycle.acquire({ scope, plan, signal });
    if (acquired === "gone") throw new Error("unexpected");
    await ports.egress.attach({ runtime: acquired.runtime, scope, fence, policy: null, signal });
    expect(fake.files.has("/workspace/.oma-egress/relay.cjs")).toBe(false);
  });
});
