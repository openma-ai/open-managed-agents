import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import {
  createPreinstalledRuntimeEnvironment,
  createProviderManagedRuntime,
  requireRuntimeEnvironmentArtifact,
  type ProviderManagedRuntimeAcquisitionContext,
  type ProviderManagedRuntimeOptions,
  type ProviderManagedRuntimeProviderPort,
  type ProviderRuntimeEnvironment,
} from "@open-managed-agents/managed-runtime-sandbox";
import type {
  ManagedRuntimeProviderDriverPort,
  RuntimeResourceScope,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";
import type {
  SandboxCheckpointHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxPort,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export type BoxLiteManagedProviderId = "litebox" | "boxrun";

export interface BoxLiteInputPort {
  write(data: Uint8Array): Promise<void>;
  writeString?(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface BoxLiteOutputPort {
  next(): Promise<string | null>;
}

export interface BoxLiteExecutionPort {
  id(): Promise<string>;
  stdin(): Promise<BoxLiteInputPort>;
  stdout(): Promise<BoxLiteOutputPort>;
  stderr(): Promise<BoxLiteOutputPort>;
  wait(): Promise<{ exitCode: number; errorMessage?: string }>;
  kill(): Promise<void>;
  signal?(signal: number): Promise<void>;
  resizeTty?(rows: number, cols: number): Promise<void>;
}

export interface BoxLiteExecutionInfo {
  executionId: string;
  argv: string[];
  startedAt: number;
  tty: boolean;
  isMainSession: boolean;
}

export interface BoxLiteExecutionInventoryPort {
  list(): Promise<BoxLiteExecutionInfo[]>;
  get(executionId: string): Promise<BoxLiteExecutionPort>;
  attach(executionId: string, stdin?: boolean): Promise<BoxLiteExecutionPort>;
}

export interface BoxLiteSnapshotInfo {
  id: string;
  boxId: string;
  name: string;
  createdAt: number;
  containerDiskBytes: number;
  sizeBytes: number;
}

export interface BoxLiteSnapshotPort {
  create(name: string, options?: Record<string, never> | null): Promise<BoxLiteSnapshotInfo>;
  list(): Promise<BoxLiteSnapshotInfo[]>;
  get(name: string): Promise<BoxLiteSnapshotInfo | null>;
  remove(name: string): Promise<void>;
  restore(name: string): Promise<void>;
}

export type BoxLiteAgentJson = null | boolean | number | string | BoxLiteAgentJson[] | { [key: string]: BoxLiteAgentJson };

export interface BoxLiteAgentsPort {
  create(agent: string, options?: Record<string, unknown>): Promise<unknown>;
  get(agentId: string): Promise<unknown>;
}

export type BoxLiteSocketAddress =
  | { type: "tcp"; host?: string; port: number }
  | { type: "unix"; path: string };

export interface BoxLiteTunnelOptions {
  isPublic?: boolean;
}

export interface BoxLiteConnectionPort {
  read(maxBytes: number): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<number>;
  shutdownWrite(): Promise<void>;
  close(): Promise<void>;
}

export interface BoxLiteTunnelForwarderPort {
  localAddr(): BoxLiteSocketAddress;
  wait(): Promise<void>;
  close(): Promise<void>;
}

export interface BoxLiteTunnelPort {
  uri(): string | null;
  isPublic(): boolean;
  token(): string | null;
  connect(): Promise<BoxLiteConnectionPort>;
  forward(listen: BoxLiteSocketAddress): Promise<BoxLiteTunnelForwarderPort>;
}

export interface BoxLiteNetworkPort {
  updateInbound(spec: { mode: "enabled" | "disabled"; allowNet?: string[] }): Promise<void>;
  updateOutbound(spec: { mode: "enabled" | "disabled"; allowNet?: string[] }): Promise<void>;
  tunnel(target: BoxLiteSocketAddress, options?: BoxLiteTunnelOptions): Promise<BoxLiteTunnelPort>;
  revokeTunnel(port: number): Promise<void>;
}

export interface BoxLiteSshAccount {
  login: string;
  authorizedKeys?: string[];
  ca?: { publicKey: string; principal: string };
}

export interface BoxLiteSshConfig {
  listenAddress: string;
  hostPrivateKey: string;
  accounts: BoxLiteSshAccount[];
}

export interface BoxLiteSshStatus {
  enabled: boolean;
  generation: bigint;
  listenAddress: string;
  hostPublicKey: string;
  hostKeyFingerprint: string;
}

export interface BoxLiteSshPort {
  configure(config: BoxLiteSshConfig): Promise<BoxLiteSshStatus>;
  enable(): Promise<BoxLiteSshStatus>;
  status(): Promise<BoxLiteSshStatus>;
  disable(): Promise<BoxLiteSshStatus>;
}

export interface BoxLiteVolumeInfo {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes?: number;
}

export interface BoxLiteVolumePort {
  create(name?: string): Promise<BoxLiteVolumeInfo>;
  list(): Promise<BoxLiteVolumeInfo[]>;
  get(id: string): Promise<BoxLiteVolumeInfo>;
  remove(id: string, force?: boolean | null): Promise<void>;
}

export interface BoxLiteImageVersion {
  digest: string;
  sizeBytes?: number;
  sourceRef: string;
  recordedAt: string;
  aliases: string[];
  lastUsedAt?: string;
  upstreamMissingAt?: string;
}

export interface BoxLiteImageInfo {
  reference: string;
  repository: string;
  tag: string;
  id: string;
  cachedAt: string;
  sizeBytes?: number;
}

export interface BoxLiteImageDetail {
  name: string;
  aliases: string[];
  curated: boolean;
  versions: BoxLiteImageVersion[];
}

export interface BoxLiteImagePort {
  pull(reference: string): Promise<{ reference: string; configDigest: string; layerCount: number }>;
  list(): Promise<BoxLiteImageInfo[]>;
  get(name: string): Promise<BoxLiteImageDetail>;
  remove(name: string): Promise<void>;
  usage(): Promise<{ count: number; limit: number; knownBytes: number }>;
  createAlias(name: string, alias: string, digest: string): Promise<BoxLiteImageDetail>;
  deleteAlias(name: string, alias: string): Promise<void>;
}

export interface BoxLiteRegistryCredential {
  id: string;
  registryHost: string;
  repositoryPrefix: string;
  username: string;
  createdBy?: string;
  createdAt?: string;
}

export interface BoxLiteRegistryPort {
  list(): Promise<BoxLiteRegistryCredential[]>;
  create(input: {
    registryHost: string;
    repositoryPrefix?: string;
    username: string;
    password: string;
  }): Promise<BoxLiteRegistryCredential>;
  remove(id: string): Promise<void>;
}

export type BoxLiteDomainTarget =
  | { type: "box"; box: string; port: number }
  | { type: "app"; app: string };

export interface BoxLiteDomainPort {
  list(): Promise<{
    domains: Array<{ hostname: string; url: string; target: BoxLiteDomainTarget | null }>;
    limit: number;
    used: number;
    remaining: number;
    minLength: number;
  }>;
  bind(domain: string, target: BoxLiteDomainTarget): Promise<{ hostname: string; url: string; target: BoxLiteDomainTarget | null }>;
  unbind(domain: string): Promise<void>;
}

export interface BoxLiteManagedRuntimeNativeCapabilities {
  readonly client: BoxLiteClientPort;
  readonly box: BoxLiteBoxSdkPort;
  readonly provider: BoxLiteManagedProviderId;
}

export interface BoxLiteBoxInfo {
  id: string;
  name?: string;
  createdAt?: string;
  state: { status: string; running: boolean; pid?: number };
  privileged?: boolean;
  network?: {
    publishedPorts?: Array<{
      hostPort?: number;
      guestPort: number;
      protocol?: string;
      hostIp?: string;
    }>;
  };
}

export interface BoxLiteBoxSdkPort {
  readonly id: string;
  readonly name: string | null;
  /** BoxLite 0.13 made info() asynchronous for both embedded and REST clients. */
  info(): BoxLiteBoxInfo | Promise<BoxLiteBoxInfo>;
  readonly agents?: BoxLiteAgentsPort;
  executions?(): BoxLiteExecutionInventoryPort;
  readonly network?: BoxLiteNetworkPort;
  readonly ssh?: BoxLiteSshPort;
  readonly snapshot?: BoxLiteSnapshotPort;
  exec(
    command: string,
    args?: string[] | null,
    env?: Array<[string, string]> | null,
    tty?: boolean | null,
    user?: string | null,
    timeoutSecs?: number | null,
    workingDir?: string | null,
  ): Promise<BoxLiteExecutionPort>;
  start(): Promise<void>;
  stop(): Promise<void>;
  copyIn(hostPath: string, containerDest: string, options?: unknown): Promise<void>;
  copyOut(containerSrc: string, hostDest: string, options?: unknown): Promise<void>;
  cloneBox?(options?: unknown, name?: string | null): Promise<BoxLiteBoxSdkPort>;
  export?(destination: string, options?: unknown): Promise<string>;
  metrics?(): Promise<Record<string, number | undefined>>;
}

export interface BoxLiteCheckpointInfo {
  id: string;
  name: string;
  sourceBoxId: string;
  createdAt?: string;
  sizeBytes?: number;
  state: "creating" | "ready" | "failed" | "deleting";
  errorReason?: string;
}

/** The managed checkpoint surface exposed by BoxLite REST (BoxRun).
 * Embedded BoxLite exposes the property too, but its implementation rejects
 * portable checkpoint operations; the provider only wires this port for REST.
 */
export interface BoxLiteCheckpointPort {
  create(source: string, name?: string | null): Promise<BoxLiteCheckpointInfo>;
  list(): Promise<BoxLiteCheckpointInfo[]>;
  get(key: string): Promise<BoxLiteCheckpointInfo>;
  remove(key: string, force?: boolean | null): Promise<void>;
}

export interface BoxLiteClientPort {
  importBox?(archivePath: string, name?: string | null): Promise<BoxLiteBoxSdkPort>;
  create?(
    options: BoxLiteCreateOptions,
    name?: string | null,
  ): Promise<BoxLiteBoxSdkPort>;
  getOrCreate(
    options: BoxLiteCreateOptions,
    name?: string | null,
  ): Promise<{ created: boolean; box: BoxLiteBoxSdkPort }>;
  get(idOrName: string): Promise<BoxLiteBoxSdkPort | null>;
  listInfo?(): Promise<BoxLiteBoxInfo[]>;
  remove(idOrName: string, force?: boolean | null): Promise<void>;
  readonly checkpoints?: BoxLiteCheckpointPort;
  readonly volumes?: BoxLiteVolumePort;
  readonly images?: BoxLiteImagePort;
  readonly registries?: BoxLiteRegistryPort;
  readonly domains?: BoxLiteDomainPort;
  metrics?(): Promise<Record<string, number | undefined>>;
  close?(): void;
  shutdown?(timeout?: number | null): Promise<void>;
}

export interface BoxLiteProviderPort
  extends ProviderManagedRuntimeProviderPort<BoxLiteManagedRuntime> {
  /** Provider-native inventory used by v2 orphan reaping and diagnostics. */
  listBoxes(): Promise<BoxLiteBoxInfo[]>;
}

export interface BoxLiteCreateOptions {
  /** A REST-managed checkpoint to create from. No other create options may be combined with it. */
  checkpoint?: string;
  image?: string;
  cpus?: number;
  memoryMib?: number;
  diskSizeGb?: number;
  workingDir?: string;
  env?: Record<string, string> | Array<{ key: string; value: string }>;
  volumes?: Array<
    | { hostPath: string; guestPath: string; readOnly?: boolean }
    | { managedVolume: string; guestPath: string; readOnly?: false }
  >;
  network?: {
    outbound?: { mode: "enabled" | "disabled"; allowNet?: string[] };
    inbound?: { mode: "enabled" | "disabled"; allowNet?: string[] };
    mode?: "enabled" | "disabled";
    allowNet?: string[];
  };
  ports?: Array<{
    hostPort?: number;
    guestPort: number;
    protocol?: string;
    hostIp?: string;
  }>;
  entrypoint?: string[];
  cmd?: string[];
  user?: string;
  autoRemove?: boolean;
  detach?: boolean;
  advanced?: Readonly<Record<string, unknown>>;
  security?: Readonly<Record<string, boolean | number | undefined>>;
  secrets?: Array<{
    name: string;
    value: string;
    hosts?: string[];
    placeholder?: string;
    /** Header templates are required by BoxLite's native secret injector. */
    headers: Record<string, string>;
  }>;
}

type SafeAllocationOptions = Omit<
  BoxLiteCreateOptions,
  "image" | "autoRemove" | "detach" | "workingDir"
>;

export interface BoxLiteProviderOptions {
  providerId: BoxLiteManagedProviderId;
  image: string;
  /**
   * Operator-owned environment that must be present for every command in the
   * guest. This is deliberately opt-in: host process environment variables
   * are never copied into a BoxLite sandbox implicitly. A common use is an
   * HTTP(S) proxy whose upstream owns Vault injection.
   */
  sandboxEnv?: Readonly<Record<string, string>>;
  client?: BoxLiteClientPort;
  connection?:
    | { type: "embedded"; homeDir?: string }
    | {
        type: "rest";
        url: string;
        /** BoxLite REST API key, sent as a bearer credential. */
        apiKey?: string;
        /** Optional organization / deployment routing prefix. */
        pathPrefix?: string;
      };
  cpus?: number;
  memoryMib?: number;
  diskSizeGb?: number;
  /** Upper bound for the provider's REST checkpoint create/poll operation. */
  checkpointTimeoutMs?: number;
  checkpointPollIntervalMs?: number;
  allocationOptions?(input: ProviderManagedRuntimeAcquisitionContext & {
    name: string;
  }): Promise<SafeAllocationOptions> | SafeAllocationOptions;
}

export interface BoxLiteManagedRuntimeOptions extends BoxLiteProviderOptions {
  leaseTtlMs: number;
  runtimeEnvironment?: ProviderRuntimeEnvironment<BoxLiteManagedRuntime>;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  credentialEgress?: ProviderManagedRuntimeOptions<BoxLiteManagedRuntime>["credentialEgress"];
  sessionInputs?: SessionInputMaterializerPort;
}

interface BoxLiteConstructorPort {
  new(options?: { homeDir?: string }): BoxLiteClientPort;
  withDefaultConfig(): BoxLiteClientPort;
  rest(options: unknown): BoxLiteClientPort;
}

interface BoxLiteRestOptionsPort {
  new(options: {
    url: string;
    credential?: unknown;
    pathPrefix?: string;
  }): unknown;
}

interface BoxLiteApiKeyCredentialPort {
  new(key: string): unknown;
}

interface BoxLiteModulePort {
  JsBoxlite: BoxLiteConstructorPort;
  BoxliteRestOptions: BoxLiteRestOptionsPort;
  ApiKeyCredential: BoxLiteApiKeyCredentialPort;
}

function stableName(providerId: BoxLiteManagedProviderId, sessionId: string): string {
  return `oma-${createHash("sha256")
    .update(`${providerId}:${sessionId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

async function loadBoxLiteClient(
  options: BoxLiteProviderOptions,
): Promise<BoxLiteClientPort> {
  if (options.client !== undefined) return options.client;
  let module: BoxLiteModulePort;
  try {
    module = await import(
      /* @vite-ignore */ "@boxlite-ai/boxlite" as string
    ) as unknown as BoxLiteModulePort;
  } catch (error) {
    throw new Error(
      `BoxLite managed runtime requires '@boxlite-ai/boxlite': ${String(error)}`,
    );
  }
  const connection = options.connection ?? { type: "embedded" as const };
  if (connection.type === "rest") {
    if (typeof module.BoxliteRestOptions !== "function" || typeof module.ApiKeyCredential !== "function") {
      throw new Error(
        "BoxLite REST managed runtime requires @boxlite-ai/boxlite 0.13.1 or newer",
      );
    }
    const credential = connection.apiKey === undefined
      ? undefined
      : new module.ApiKeyCredential(connection.apiKey);
    return module.JsBoxlite.rest(new module.BoxliteRestOptions({
      url: connection.url,
      ...(credential === undefined ? {} : { credential }),
      ...(connection.pathPrefix === undefined ? {} : { pathPrefix: connection.pathPrefix }),
    }));
  }
  return connection.homeDir === undefined
    ? module.JsBoxlite.withDefaultConfig()
    : new module.JsBoxlite({ homeDir: connection.homeDir });
}

type BoxLiteClientResolver = () => Promise<BoxLiteClientPort>;

async function boxInfo(box: BoxLiteBoxSdkPort): Promise<BoxLiteBoxInfo> {
  return await box.info();
}

function createClientResolver(
  options: BoxLiteProviderOptions,
): BoxLiteClientResolver {
  let clientPromise: Promise<BoxLiteClientPort> | undefined;
  return () => clientPromise ??= loadBoxLiteClient(options);
}

async function collectOutput(stream: BoxLiteOutputPort): Promise<string> {
  let result = "";
  for (;;) {
    const next = await stream.next();
    if (next === null) return result;
    result += next;
  }
}

function readableOutput(
  source: Promise<BoxLiteOutputPort>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const output = await source;
        for (;;) {
          const next = await output.next();
          if (next === null) break;
          controller.enqueue(encoder.encode(next));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function envPairs(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Array<[string, string]> {
  return Object.entries(env ?? {}).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as [string, string]],
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function executeAndCollect(
  box: BoxLiteBoxSdkPort,
  command: string,
  args: string[],
  env: Array<[string, string]>,
  timeoutSeconds: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const execution = await box.exec(
    command,
    args,
    env,
    false,
    null,
    timeoutSeconds,
    undefined,
  );
  const [stdout, stderr, result] = await Promise.all([
    execution.stdout().then(collectOutput),
    execution.stderr().then(collectOutput),
    execution.wait(),
  ]);
  return { stdout, stderr, exitCode: result.exitCode };
}

export class BoxLiteManagedRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #providerId: BoxLiteManagedProviderId;
  readonly #client: BoxLiteClientPort;
  readonly #box: BoxLiteBoxSdkPort;
  readonly #expectedName: string;
  readonly #checkpoints?: BoxLiteCheckpointPort;
  readonly #checkpointTimeoutMs: number;
  readonly #checkpointPollIntervalMs: number;
  readonly #sandboxEnv: Record<string, string>;
  #destroyed = false;

  constructor(input: {
    providerId: BoxLiteManagedProviderId;
    client: BoxLiteClientPort;
    box: BoxLiteBoxSdkPort;
    expectedName: string;
    sandboxEnv?: Readonly<Record<string, string>>;
    checkpoints?: BoxLiteCheckpointPort;
    checkpointTimeoutMs?: number;
    checkpointPollIntervalMs?: number;
  }) {
    this.#providerId = input.providerId;
    this.#client = input.client;
    this.#box = input.box;
    this.#expectedName = input.expectedName;
    this.#sandboxEnv = { ...(input.sandboxEnv ?? {}) };
    this.#checkpoints = input.checkpoints;
    this.#checkpointTimeoutMs = input.checkpointTimeoutMs ?? 120_000;
    this.#checkpointPollIntervalMs = input.checkpointPollIntervalMs ?? 250;
  }

  runtimeHandle() {
    return { provider: this.#providerId, runtimeId: this.#box.id };
  }

  /** Full provider-native BoxLite surface for callers that need capabilities
   * beyond the provider-neutral Sandbox SDK v2 Ports. */
  boxLiteCapabilities(): BoxLiteManagedRuntimeNativeCapabilities {
    return { client: this.#client, box: this.#box, provider: this.#providerId };
  }

  runtimeCapabilities() {
    return {
      lease: false,
      suspend: ["filesystem" as const],
      checkpoint: this.#checkpoints === undefined ? [] : ["filesystem" as const],
    };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    const info = await boxInfo(this.#box);
    if (info.state.running) return "running";
    return /stop|exit/i.test(info.state.status) ? "suspended" : "unknown";
  }

  async renewLease(): Promise<void> {
    if (await this.status() === "stopped") {
      throw new Error("BoxLite runtime has been removed");
    }
  }

  /** Install operator-managed environment for all future guest commands.
   * Explicit runtime environment wins over ACP-provided per-process values so
   * an agent cannot bypass the configured egress proxy. */
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    Object.assign(this.#sandboxEnv, envVars);
  }

  private commandEnv(env?: Readonly<Record<string, string | undefined>>): Array<[string, string]> {
    return envPairs({ ...env, ...this.#sandboxEnv });
  }

  async suspend(input: { kind: "filesystem" | "memory" }): Promise<SandboxCheckpointHandle> {
    if (input.kind !== "filesystem") {
      throw new Error("BoxLite retained runtime supports filesystem suspension only");
    }
    await this.#box.stop();
    return {
      provider: this.#providerId,
      checkpointId: this.#box.id,
      sourceRuntimeId: this.#box.id,
      kind: "filesystem",
      scope: "runtime",
      metadata: { ownershipName: this.#expectedName },
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (
      checkpoint.provider !== this.#providerId
      || checkpoint.scope !== "runtime"
      || checkpoint.sourceRuntimeId !== this.#box.id
    ) {
      throw new Error("BoxLite runtime can only resume its own retained checkpoint");
    }
    await this.#box.start();
  }

  async checkpoint(input: { name?: string } = {}): Promise<SandboxCheckpointHandle> {
    const checkpoints = this.#checkpoints;
    if (checkpoints === undefined) {
      throw new Error(
        "BoxLite embedded runtime does not support portable workspace checkpoints; use BoxRun REST",
      );
    }
    const wasRunning = (await boxInfo(this.#box)).state.running;
    if (wasRunning) await this.#box.stop();
    try {
      const created = await checkpoints.create(
        this.#box.id,
        input.name ?? this.#expectedName,
      );
      const deadline = Date.now() + this.#checkpointTimeoutMs;
      let info = created;
      while (info.state === "creating") {
        if (Date.now() >= deadline) {
          throw new Error(
            `BoxLite checkpoint ${info.id} did not become ready within ${this.#checkpointTimeoutMs}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.#checkpointPollIntervalMs));
        info = await checkpoints.get(info.id);
      }
      if (info.state !== "ready") {
        throw new Error(
          `BoxLite checkpoint ${info.id} failed: ${info.errorReason ?? info.state}`,
        );
      }
      return {
        provider: this.#providerId,
        checkpointId: info.id,
        sourceRuntimeId: this.#box.id,
        kind: "filesystem",
        scope: "portable",
        metadata: { name: info.name },
      };
    } finally {
      if (wasRunning) await this.#box.start();
    }
  }

  async exec(command: string, timeoutMs = 120_000): Promise<string> {
    const result = await executeAndCollect(
      this.#box,
      "/bin/sh",
      ["-lc", `cd /workspace && ${command}`],
      this.commandEnv(),
      Math.max(1, Math.ceil(timeoutMs / 1_000)),
    );
    const output = `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`
      .replace(/\s+$/g, "");
    return result.exitCode === 0 ? output : `${output}\n[exit ${result.exitCode}]`;
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), "openma-boxlite-read-"));
    const target = join(directory, "content");
    try {
      await this.#box.copyOut(path, target);
      return new Uint8Array(await readFile(target));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "openma-boxlite-write-"));
    const source = join(directory, "content");
    try {
      await writeFile(source, bytes);
      const parent = dirname(path);
      const mkdirResult = await executeAndCollect(
        this.#box,
        "mkdir",
        ["-p", parent],
        this.commandEnv(),
        30,
      );
      if (mkdirResult.exitCode !== 0) {
        throw new Error(`BoxLite failed to create ${parent}: ${mkdirResult.stderr}`);
      }
      await this.#box.copyIn(source, path);
      return path;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const processEnv = this.commandEnv(spec.env);
    const cwd = spec.cwd ?? "/workspace";
    const command = "/bin/sh";
    const args = [
      "-lc",
      `cd ${shellQuote(cwd)} && exec ${shellQuote(spec.command)}${spec.args === undefined || spec.args.length === 0
        ? ""
        : ` ${spec.args.map(shellQuote).join(" ")}`}`,
    ];
    const execution = await this.#box.exec(
      command,
      args,
      processEnv,
      false,
      null,
      0,
      undefined,
    );
    const input = execution.stdin();
    const exited = execution.wait().then((result) => ({
      code: result.exitCode,
      signal: null,
    }));
    return {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await (await input).write(Buffer.from(chunk));
        },
        async close() {
          await (await input).close();
        },
        async abort() {
          await execution.kill();
        },
      }),
      stdout: readableOutput(execution.stdout()),
      stderr: readableOutput(execution.stderr()),
      exited,
      async kill(signal = "SIGTERM") {
        if (signal === "SIGTERM" && execution.signal !== undefined) {
          await execution.signal(15);
          return;
        }
        await execution.kill();
      },
    };
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#client.remove(this.#box.id, true);
    this.#destroyed = true;
  }
}

function validateBox(
  box: BoxLiteBoxSdkPort,
  expectedName: string,
): void {
  if (box.id === "" || box.name !== expectedName) {
    throw new Error(
      `BoxLite runtime ownership name mismatch: expected ${expectedName}, received ${String(box.name)}`,
    );
  }
}

async function ensureRunning(box: BoxLiteBoxSdkPort): Promise<void> {
  if (!(await boxInfo(box)).state.running) await box.start();
}

async function ensureWorkspace(box: BoxLiteBoxSdkPort): Promise<void> {
  const result = await executeAndCollect(
    box,
    "mkdir",
    ["-p", "/workspace"],
    [],
    30,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `BoxLite failed to prepare /workspace: ${result.stderr || result.stdout}`,
    );
  }
}

function createBoxLiteProviderWithClient(
  options: BoxLiteProviderOptions,
  client: BoxLiteClientResolver,
): BoxLiteProviderPort {
  const runtime = (
    sdk: BoxLiteClientPort,
    box: BoxLiteBoxSdkPort,
    expectedName: string,
  ) => new BoxLiteManagedRuntime({
    providerId: options.providerId,
    client: sdk,
    box,
    expectedName,
    ...(options.sandboxEnv === undefined ? {} : { sandboxEnv: options.sandboxEnv }),
    ...(options.connection?.type === "rest" && sdk.checkpoints !== undefined
      ? { checkpoints: sdk.checkpoints }
      : {}),
    ...(options.checkpointTimeoutMs === undefined
      ? {}
      : { checkpointTimeoutMs: options.checkpointTimeoutMs }),
    ...(options.checkpointPollIntervalMs === undefined
      ? {}
      : { checkpointPollIntervalMs: options.checkpointPollIntervalMs }),
  });

  const provider: BoxLiteProviderPort = {
    async create(context, _environment, acquisition) {
      if (acquisition === undefined) {
        throw new Error("BoxLite managed allocation requires acquisition context");
      }
      acquisition.signal.throwIfAborted();
      const sdk = await client();
      if (options.connection?.type === "rest" && sdk.checkpoints === undefined) {
        throw new Error(
          "BoxLite REST managed checkpoints require @boxlite-ai/boxlite 0.13 or newer",
        );
      }
      const name = stableName(options.providerId, context.sessionId);
      const extra = await options.allocationOptions?.({ ...acquisition, name }) ?? {};
      acquisition.signal.throwIfAborted();
      const result = await sdk.getOrCreate({
        image: requireRuntimeEnvironmentArtifact(
          acquisition.environment,
          options.providerId,
          ["image"],
        ).reference,
        ...(options.cpus === undefined ? {} : { cpus: options.cpus }),
        ...(options.memoryMib === undefined ? {} : { memoryMib: options.memoryMib }),
        ...(options.diskSizeGb === undefined ? {} : { diskSizeGb: options.diskSizeGb }),
        ...extra,
        autoRemove: false,
        detach: true,
      }, name);
      try {
        validateBox(result.box, name);
        await ensureRunning(result.box);
        await ensureWorkspace(result.box);
      } catch (error) {
        if (result.created) await Promise.allSettled([sdk.remove(result.box.id, true)]);
        throw error;
      }
      return runtime(sdk, result.box, name);
    },

    async resume(handle, context, _environment, acquisition) {
      if (handle.provider !== options.providerId || handle.runtimeId === "") {
        throw new Error("BoxLite provider received an incompatible runtime handle");
      }
      acquisition?.signal.throwIfAborted();
      const sdk = await client();
      const box = await sdk.get(handle.runtimeId);
      if (box === null) throw new Error(`BoxLite runtime not found: ${handle.runtimeId}`);
      const name = stableName(options.providerId, context.sessionId);
      validateBox(box, name);
      await ensureRunning(box);
      await ensureWorkspace(box);
      acquisition?.signal.throwIfAborted();
      return runtime(sdk, box, name);
    },

    async restore(checkpoint, context, _environment, acquisition) {
      if (
        checkpoint.provider !== options.providerId
        || checkpoint.scope !== "portable"
        || checkpoint.kind !== "filesystem"
        || checkpoint.checkpointId === ""
      ) {
        throw new Error("BoxLite provider received an incompatible portable checkpoint");
      }
      if (options.connection?.type !== "rest") {
        throw new Error(
          "BoxLite embedded runtime does not support portable workspace restore; use BoxRun REST",
        );
      }
      acquisition?.signal.throwIfAborted();
      const sdk = await client();
      if (sdk.checkpoints === undefined) {
        throw new Error("BoxLite REST client does not expose managed checkpoints");
      }
      const name = stableName(options.providerId, context.sessionId);
      const result = sdk.create === undefined
        ? await sdk.getOrCreate({ checkpoint: checkpoint.checkpointId }, name)
        : { created: true, box: await sdk.create({ checkpoint: checkpoint.checkpointId }, name) };
      try {
        validateBox(result.box, name);
        await ensureRunning(result.box);
        await ensureWorkspace(result.box);
        acquisition?.signal.throwIfAborted();
        return runtime(sdk, result.box, name);
      } catch (error) {
        if (result.created) await Promise.allSettled([sdk.remove(result.box.id, true)]);
        throw error;
      }
    },
    async discard(checkpoint) {
      if (checkpoint.provider !== options.providerId || checkpoint.scope !== "portable") return;
      const sdk = await client();
      await sdk.checkpoints?.remove(checkpoint.checkpointId, true);
    },
    async listBoxes() {
      const sdk = await client();
      return sdk.listInfo === undefined ? [] : sdk.listInfo();
    },
  };
  return provider;
}

export function createBoxLiteProvider(
  options: BoxLiteProviderOptions,
): BoxLiteProviderPort {
  return createBoxLiteProviderWithClient(options, createClientResolver(options));
}

export function createBoxLiteManagedRuntime(options: BoxLiteManagedRuntimeOptions) {
  const supportsPortableCheckpoints = options.connection?.type === "rest";
  const client = createClientResolver(options);
  const provider = createBoxLiteProviderWithClient(options, client);
  return createProviderManagedRuntime({
    providerName: options.providerId,
    provider,
    context: (scope: RuntimeResourceScope): SandboxFactoryContext => ({
      sessionId: scope.sessionId,
      workdir: "/workspace",
    }),
    environment: (): SandboxFactoryEnv => ({}),
    runtimeEnvironment: options.runtimeEnvironment
      ?? createPreinstalledRuntimeEnvironment({
        type: "base",
        identity: options.image,
        artifact: { type: "image", reference: options.image },
      }),
    leaseTtlMs: options.leaseTtlMs,
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      // BoxLite checkpoints are workspace restore points. RuntimeCheckpointPort
      // is intentionally not wired until the host publication transaction has
      // an explicit provider implementation for them.
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: supportsPortableCheckpoints
        ? ["retained_runtime", "checkpoint_restore"]
        : ["retained_runtime"],
      retainedSuspendKind: "filesystem",
      ...(supportsPortableCheckpoints ? { portableCheckpointKind: "filesystem" as const } : {}),
    },
    ...(options.outputStore === undefined || options.outputStore === null
      ? {}
      : {
          outputs: {
            store: options.outputStore,
            keyPrefix: options.outputKeyPrefix ?? "managed-runtime-output-candidates",
            durability: "durable" as const,
          },
        }),
    ...(options.credentialEgress === undefined
      ? {}
      : { credentialEgress: options.credentialEgress }),
    reapRuntime: async ({ lease, context }) => {
      const sdk = await client();
      const box = await sdk.get(lease.runtimeId);
      if (box === null) return;
      validateBox(box, stableName(options.providerId, context.sessionId));
      await sdk.remove(lease.runtimeId, true);
    },
    drivers: ["ama_worker"],
  });
}

export function createBoxLiteManagedRuntimeDriver(
  options: BoxLiteManagedRuntimeOptions,
): ManagedRuntimeProviderDriverPort {
  const supportsPortableCheckpoints = options.connection?.type === "rest";
  const hasOutputs = options.outputStore !== undefined && options.outputStore !== null;
  return {
    descriptor() {
      return {
        provider: options.providerId,
        version: "1.0.0",
        placements: ["in_process"],
        capabilities: {
          sandbox: {
            suspendResume: "supported",
            hardTerminate: "supported",
            runtimeCheckpoints: [],
          },
          workspace: {
            strategies: supportsPortableCheckpoints
              ? ["retained_runtime", "checkpoint_restore"]
              : ["retained_runtime"],
          },
          outputs: {
            strategies: hasOutputs
              ? [{ strategy: "final_collect", durability: "durable" }]
              : [],
          },
          harness: { drivers: ["ama_worker", "openma_supervised"] },
        },
        credentialEgress: options.credentialEgress?.capabilities ?? {
          enforcement: "unsupported",
          credentialMode: "snapshot",
          interceptedProtocols: [],
        },
      };
    },
    async create(input) {
      if (input.placement !== "in_process") {
        throw new Error(`BoxLite driver does not support ${input.placement} placement`);
      }
      const resources = createBoxLiteManagedRuntime(options);
      return {
        sandbox: resources.sandbox,
        workspace: resources.workspace,
        outputs: resources.outputs,
        harnessDriver: resources.harness,
        supervisorTransport: resources.supervisorTransport,
        ...(resources.credentialEgress === undefined
          ? {}
          : { credentialEgress: resources.credentialEgress }),
        ...(options.sessionInputs === undefined
          ? {}
          : { sessionInputs: options.sessionInputs }),
      };
    },
  };
}
