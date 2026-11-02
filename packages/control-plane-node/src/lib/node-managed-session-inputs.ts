import { posix } from "node:path";
import { unzipSync } from "fflate";
import {
  supportsSessionOutputMount,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import type {
  FilesApplicationPort,
  MemoriesApplicationPort,
  Session,
  SkillVersionsApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionResourceSecretSource } from "@open-managed-agents/session-resource-store";
import type { NodeManagedMemorySnapshotPort } from "./node-managed-memory-snapshots.js";
import {
  materializeNodeManagedMemoryStores,
  nodeManagedMemoryRoot,
  nodeManagedMemoryStoreName,
} from "./node-managed-memory-stores.js";
import { resolveAppendablePrompts } from "@open-managed-agents/agent/runtime/appendable-prompts";
import type { SkillMountDescriptor } from "@open-managed-agents/agent/harness/skills";
import {
  resolveSkillAssemblyConfig,
  skillMountsShouldFetchBodies,
} from "@open-managed-agents/agent/harness/assembly/skill-config";
import { toLegacyHarnessAgentConfig } from "./node-managed-agent-codec.js";

type FileSource = Pick<FilesApplicationPort, "downloadFile">;
type SkillVersionSource = Pick<
  SkillVersionsApplicationPort,
  "downloadSkillVersion" | "listSkillVersions" | "retrieveSkillVersion"
>;

function skillMdBodyFromArchive(archive: Uint8Array): string | undefined {
  const files = unzipSync(archive);
  for (const [rawPath, content] of Object.entries(files)) {
    if (rawPath.endsWith("/")) continue;
    const path = safeArchivePath(rawPath);
    if (posix.basename(path) !== "SKILL.md") continue;
    return new TextDecoder().decode(content);
  }
  return undefined;
}

async function resolveConcreteSkillVersion(
  skillVersions: SkillVersionSource,
  skillId: string,
  requestedVersion: string,
): Promise<{ version: string; name: string; description: string } | undefined> {
  if (requestedVersion === "latest") {
    const listed = await skillVersions.listSkillVersions({ skillId, pageSize: 1 });
    if (listed.type !== "page" || listed.page.versions.length === 0) return undefined;
    const view = listed.page.versions[0]!;
    return {
      version: view.version,
      name: view.name,
      description: view.description,
    };
  }
  const retrieved = await skillVersions.retrieveSkillVersion({
    skillId,
    version: requestedVersion,
  });
  if (retrieved.type !== "found") return undefined;
  return {
    version: retrieved.version.version,
    name: retrieved.version.name,
    description: retrieved.version.description,
  };
}

export interface PrepareNodeManagedSessionInputs {
  workspaceId: string;
  session: Session;
  sandbox: SandboxExecutor;
  /** Stable identifier for this concrete sandbox incarnation. Writable
   * Memory workspaces use it as an isolation/fencing boundary. */
  runtimeGeneration?: string;
  /** The Session execution fence check. File sync revalidates it before
   * writing back edits a retained sandbox still holds; without it a writable
   * Memory Store is refused. Unused by native mounts. */
  authorizeMemoryMutation?(): Promise<boolean>;
  signal?: AbortSignal;
}

/**
 * The workspace's Bond credential for a repository URL, for resources added
 * without a token (`credentialSource: "bond"`). Asked each time a sandbox is
 * prepared, so a rotated or revoked Bond takes effect then. Throws when no
 * Bond of the workspace covers the URL.
 */
export interface RepositoryBondCredentialSource {
  repositoryToken(input: { workspaceId: string; url: string }): Promise<string>;
}

export interface NodeManagedSessionInputPreparerDependencies {
  files: FileSource;
  skillVersions: SkillVersionSource;
  repositoryCredentials: Pick<SessionResourceSecretSource, "findGithubToken">;
  /** Unset: repositories without a token cannot be prepared. */
  repositoryBonds?: RepositoryBondCredentialSource;
  memoryStores: NodeManagedMemoryStoreMode;
  /** Shared OSS collection uses provider-local outputs, not a FUSE mount. */
  sharedOutputs?: boolean;
}

/** How Memory Stores reach the sandbox, decided once from the composed
 * sandbox factory (see docs/memory-stores.md). */
export type NodeManagedMemoryStoreMode =
  /** `SandboxFactoryCapabilities.nativeMemoryStoreMount`: mount a
   * generation-scoped blob snapshot through `SandboxPort.mountMemoryStore`. */
  | { mode: "native"; snapshots: NodeManagedMemorySnapshotPort }
  /** Default: copy each store into /mnt/memory/<name>/ through the shared
   * Memory Store file sync. */
  | { mode: "file_sync"; memories: MemoriesApplicationPort };

/** The Memory Store mode for a composed sandbox factory. Native mounts are
 * opt-in at factory level; there is no runtime switch and no fallback. */
export function nodeManagedMemoryStoreModeName(
  factory: { capabilities?: { nativeMemoryStoreMount?: boolean } },
): NodeManagedMemoryStoreMode["mode"] {
  return factory.capabilities?.nativeMemoryStoreMount === true ? "native" : "file_sync";
}

export function buildNodeManagedSkillReminders(
  session: Session,
): Array<{ source: string; text: string }> {
  return session.agent.skills.flatMap((skill) => {
    if (skill.type !== "custom") return [];
    const requestedVersion = skill.version ?? "latest";
    const mountRoot = `/workspace/.openma/skills/${encodeURIComponent(skill.skillId)}/${encodeURIComponent(requestedVersion)}/`;
    return [{
      source: `skill:${skill.skillId}`,
      text: `Custom skill ${skill.skillId} is mounted at ${mountRoot}. Locate and read its SKILL.md before applying it.`,
    }];
  });
}

/** @deprecated Prefer {@link resolveNodeManagedSkillMounts} for assembly harnesses. */
export function buildNodeManagedSkillMounts(
  session: Session,
): SkillMountDescriptor[] {
  return session.agent.skills.flatMap((skill) => {
    if (skill.type !== "custom") return [];
    const requestedVersion = skill.version ?? "latest";
    const mountRoot = `/workspace/.openma/skills/${encodeURIComponent(skill.skillId)}/${encodeURIComponent(requestedVersion)}/`;
    return [{
      skillId: skill.skillId,
      name: skill.skillId,
      description: `Custom skill mounted at ${mountRoot}`,
      mountRoot,
      source: "custom",
    }];
  });
}

export async function resolveNodeManagedSkillMounts(
  session: Session,
  skillVersions: SkillVersionSource,
): Promise<SkillMountDescriptor[]> {
  const agent = toLegacyHarnessAgentConfig(session);
  const skillConfig = resolveSkillAssemblyConfig(agent);
  const fetchBodies = skillMountsShouldFetchBodies(skillConfig.mode);
  const mounts: SkillMountDescriptor[] = [];

  for (const skill of session.agent.skills) {
    if (skill.type !== "custom") continue;
    const requestedVersion = skill.version ?? "latest";
    const mountRoot = `/workspace/.openma/skills/${encodeURIComponent(skill.skillId)}/${encodeURIComponent(requestedVersion)}/`;
    const resolved = await resolveConcreteSkillVersion(
      skillVersions,
      skill.skillId,
      requestedVersion,
    );
    if (!resolved) continue;

    let body: string | undefined;
    if (fetchBodies) {
      const downloaded = await skillVersions.downloadSkillVersion({
        skillId: skill.skillId,
        version: resolved.version,
      });
      if (downloaded.type === "found") {
        body = skillMdBodyFromArchive(downloaded.file.content);
      }
    }

    mounts.push({
      skillId: skill.skillId,
      name: resolved.name,
      description: resolved.description || `Custom skill mounted at ${mountRoot}`,
      mountRoot,
      ...(body?.trim() ? { body } : {}),
      source: "custom",
    });
  }

  return mounts;
}

export function buildNodeManagedAppendablePromptReminders(
  session: Session,
): Array<{ source: string; text: string }> {
  return resolveAppendablePrompts(
    session.agent.openma?.appendablePrompts ?? [],
  ).map((prompt) => ({
    source: `appendable:${prompt.id}`,
    text: prompt.content,
  }));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellWorkspacePath(value: string): string {
  if (value === "/workspace") return ".";
  return value.startsWith("/workspace/")
    ? value.slice("/workspace/".length)
    : value;
}

function assertCommandSucceeded(command: string, output: string): void {
  const prefixedExit = /^exit=(-?\d+)\n/u.exec(output);
  if (
    (prefixedExit !== null && Number(prefixedExit[1]) !== 0)
    || /\[(?:error:|exit (?!exit=0\]))/u.test(output)
  ) {
    throw new Error(`${command} failed: ${output}`);
  }
}

function commandStdout(command: string, output: string): string {
  assertCommandSucceeded(command, output);
  return output.replace(/^exit=0\n/u, "").trim();
}

function safeArchivePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    value.includes("\0")
    || normalized === "."
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe skill archive path: ${value}`);
  }
  return normalized;
}

/** Materializes the immutable inputs needed by the in-process Node harness.
 * This is deliberately an injected adapter: the runner owns ordering while
 * Files/Skills storage and sandbox I/O stay behind their existing ports. */
export class NodeManagedSessionInputPreparer {
  constructor(
    private readonly dependencies: NodeManagedSessionInputPreparerDependencies,
  ) {}

  async prepare(input: PrepareNodeManagedSessionInputs): Promise<void> {
    if (!this.dependencies.sharedOutputs) {
      if (!supportsSessionOutputMount(input.sandbox)) {
        throw new Error(
          "Managed Session runtime requires durable session outputs, but the selected sandbox does not provide them",
        );
      }
      await input.sandbox.mountSessionOutputs({
        tenantId: input.workspaceId,
        sessionId: input.session.id,
      });
    }
    await input.sandbox.setEnvVars?.({
      OMA_OUTPUTS_DIR: "/mnt/session/outputs",
    });

    await this.prepareMemoryStores(input);

    if (this.dependencies.sharedOutputs) {
      const command = "mkdir -p /mnt/session/outputs";
      assertCommandSucceeded(command, await input.sandbox.exec(command, 30_000));
    }

    const repositories = input.session.resources.filter(
      (resource) => resource.type === "github_repository",
    );
    if (repositories.length > 0) {
      if (input.sandbox.registerCommandSecrets === undefined) {
        throw new Error(
          "Managed Session has GitHub repositories, but the selected sandbox cannot scope repository credentials",
        );
      }
      const gitCredentialEnv: Record<string, string> = {
        GIT_CONFIG_COUNT: String(repositories.length),
      };
      for (const [index, resource] of repositories.entries()) {
        const token = await this.repositoryToken(input, resource);
        if (token === null) {
          throw new Error(
            `Managed Session GitHub credential for resource ${resource.id} was not found`,
          );
        }
        gitCredentialEnv[`GIT_CONFIG_KEY_${index}`] =
          `http.${resource.url}.extraHeader`;
        gitCredentialEnv[`GIT_CONFIG_VALUE_${index}`] =
          `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      }
      input.sandbox.registerCommandSecrets("git", gitCredentialEnv);
    }

    const writeFileBytes = input.sandbox.writeFileBytes;
    const needsBinaryWrites = input.session.resources.some(
      (resource) => resource.type === "file",
    ) || input.session.agent.skills.some((skill) => skill.type === "custom");
    if (needsBinaryWrites && writeFileBytes === undefined) {
      throw new Error("Managed Session inputs require sandbox binary file writes");
    }

    for (const resource of input.session.resources) {
      if (resource.type === "file") {
        const downloaded = await this.dependencies.files.downloadFile({
          fileId: resource.fileId,
        });
        if (downloaded.type !== "found") {
          throw new Error(`Managed Session file ${resource.fileId} was not found`);
        }
        await writeFileBytes!.call(
          input.sandbox,
          resource.mountPath,
          downloaded.file.content,
        );
        continue;
      }
      if (resource.type === "github_repository") {
        await this.materializeRepository(input.sandbox, resource);
      }
    }

    for (const skill of input.session.agent.skills) {
      if (skill.type !== "custom") continue;
      const requestedVersion = skill.version ?? "latest";
      let concreteVersion = requestedVersion;
      if (requestedVersion === "latest") {
        const listed = await this.dependencies.skillVersions.listSkillVersions({
          skillId: skill.skillId,
          pageSize: 1,
        });
        if (listed.type !== "page" || listed.page.versions.length === 0) {
          throw new Error(`Managed Skill ${skill.skillId} has no version`);
        }
        concreteVersion = listed.page.versions[0]!.version;
      }
      const downloaded = await this.dependencies.skillVersions.downloadSkillVersion({
        skillId: skill.skillId,
        version: concreteVersion,
      });
      if (downloaded.type !== "found") {
        throw new Error(`Managed Skill ${skill.skillId}@${concreteVersion} was not found`);
      }
      const archive = unzipSync(downloaded.file.content);
      let foundManifest = false;
      for (const [rawPath, content] of Object.entries(archive)) {
        if (rawPath.endsWith("/")) continue;
        const path = safeArchivePath(rawPath);
        if (posix.basename(path) === "SKILL.md") foundManifest = true;
        await writeFileBytes!.call(
          input.sandbox,
          `/workspace/.openma/skills/${encodeURIComponent(skill.skillId)}/${encodeURIComponent(requestedVersion)}/${path}`,
          content,
        );
      }
      if (!foundManifest) {
        throw new Error(
          `Managed Skill ${skill.skillId}@${concreteVersion} archive has no SKILL.md`,
        );
      }
    }
  }

  private async prepareMemoryStores(input: PrepareNodeManagedSessionInputs): Promise<void> {
    const memoryStores = input.session.resources.filter(
      (resource) => resource.type === "memory_store",
    );
    if (memoryStores.length === 0) return;
    const mode = this.dependencies.memoryStores;
    if (mode.mode === "file_sync") {
      const writable = memoryStores.find((resource) => resource.access !== "read_only");
      const authorize = input.authorizeMemoryMutation;
      if (writable !== undefined && authorize === undefined) {
        throw new Error(
          `Writable Managed Memory Store ${writable.memoryStoreId} requires a Session execution fence`,
        );
      }
      await materializeNodeManagedMemoryStores({
        session: input.session,
        sandbox: input.sandbox,
        memories: mode.memories,
        // Read-only stores never write back, so they never consult it.
        authorize: authorize ?? (async () => false),
        signal: input.signal ?? new AbortController().signal,
      });
    } else {
      if (input.sandbox.mountMemoryStore === undefined) {
        throw new Error(
          "The sandbox factory declares native Memory Store mounts, but the sandbox does not implement mountMemoryStore",
        );
      }
      for (const resource of memoryStores) {
        const access = resource.access === "read_only" ? "read_only" : "read_write";
        if (access === "read_write" && input.runtimeGeneration === undefined) {
          throw new Error(
            `Writable Managed Memory Store ${resource.memoryStoreId} requires a runtime generation`,
          );
        }
        const snapshot = await mode.snapshots.materialize({
          workspaceId: input.workspaceId,
          sessionId: input.session.id,
          memoryStoreId: resource.memoryStoreId,
          access,
          ...(access === "read_write"
            ? { runtimeGeneration: input.runtimeGeneration }
            : {}),
        });
        await input.sandbox.mountMemoryStore({
          storeName: nodeManagedMemoryStoreName(resource),
          storeId: snapshot.mountStoreId,
          readOnly: access === "read_only",
        });
      }
    }
    for (const resource of memoryStores) {
      const storeName = nodeManagedMemoryStoreName(resource);
      await input.sandbox.setEnvVars?.({
        OMA_MEMORY_DIR: nodeManagedMemoryRoot,
        [`OMA_MEMORY_${storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]:
          `${nodeManagedMemoryRoot}/${storeName}`,
      });
    }
  }

  private async repositoryToken(
    input: PrepareNodeManagedSessionInputs,
    resource: Extract<Session["resources"][number], { type: "github_repository" }>,
  ): Promise<string | null> {
    if (resource.credentialSource !== "bond") {
      return this.dependencies.repositoryCredentials.findGithubToken({
        workspaceId: input.workspaceId,
        sessionId: input.session.id,
        resourceId: resource.id,
      });
    }
    if (this.dependencies.repositoryBonds === undefined) {
      throw new Error(
        `Managed Session repository ${resource.url} has no token, and this deployment has no Bonds to clone it with`,
      );
    }
    return this.dependencies.repositoryBonds.repositoryToken({
      workspaceId: input.workspaceId,
      url: resource.url,
    });
  }

  private async materializeRepository(
    sandbox: SandboxExecutor,
    resource: Extract<Session["resources"][number], { type: "github_repository" }>,
  ): Promise<void> {
    // A restarted Node process can reopen a retained workspace. Preserve its
    // edits instead of destructively cloning over the repository again.
    let retained = true;
    try {
      await sandbox.readFile(`${resource.mountPath}/.git/HEAD`);
    } catch {
      retained = false;
    }
    if (!retained) return this.cloneRepository(sandbox, resource);

    const repositoryDir = shellQuote(shellWorkspacePath(resource.mountPath));
    const remoteCommand = `git -C ${repositoryDir} remote get-url origin`;
    const remote = commandStdout(
      remoteCommand,
      await sandbox.exec(remoteCommand, 30_000),
    );
    if (remote !== resource.url) {
      throw new Error(
        `Retained repository at ${resource.mountPath} does not match Session resource ${resource.id}: expected ${resource.url}, found ${remote || "no origin"}`,
      );
    }
    if (resource.checkout?.type === "commit") {
      const commitCommand = `git -C ${repositoryDir} cat-file -e ${shellQuote(`${resource.checkout.sha}^{commit}`)}`;
      commandStdout(
        commitCommand,
        await sandbox.exec(commitCommand, 30_000),
      );
    }
    // A Bond-backed repository outlives a token: a long-lived Session sees
    // tags and branches pushed since it was cloned. The working tree is not
    // touched, so the Agent's edits stay.
    if (resource.credentialSource === "bond") {
      const fetchCommand = `git -C ${repositoryDir} fetch --quiet --tags --force --prune origin`;
      assertCommandSucceeded(fetchCommand, await sandbox.exec(fetchCommand, 120_000));
    }
  }

  private async cloneRepository(
    sandbox: SandboxExecutor,
    resource: Extract<Session["resources"][number], { type: "github_repository" }>,
  ): Promise<void> {
    if (sandbox.gitCheckout !== undefined) {
      await sandbox.gitCheckout(resource.url, {
        targetDir: resource.mountPath,
        ...(resource.checkout?.type === "branch"
          ? { branch: resource.checkout.name }
          : {}),
      });
    } else {
      const branch = resource.checkout?.type === "branch"
        ? `--branch ${shellQuote(resource.checkout.name)} `
        : "";
      const command = `git clone ${branch}-- ${shellQuote(resource.url)} ${shellQuote(shellWorkspacePath(resource.mountPath))}`;
      const output = await sandbox.exec(command, 120_000);
      assertCommandSucceeded(command, output);
    }
    if (resource.checkout?.type === "commit") {
      const command = `git -C ${shellQuote(shellWorkspacePath(resource.mountPath))} checkout --detach ${shellQuote(resource.checkout.sha)}`;
      const output = await sandbox.exec(command, 60_000);
      assertCommandSucceeded(command, output);
    }
  }
}
