import { posix } from "node:path";
import { unzipSync } from "fflate";
import {
  PLATFORM_ROOT,
  supportsSessionOutputMount,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import {
  assertCommandSucceeded,
  commandScopedRepositoryAccess,
  mountSessionResources,
  type RepositoryMount,
} from "@open-managed-agents/session-runtime";
import type {
  FilesApplicationPort,
  MemoriesApplicationPort,
  Session,
  SkillVersionsApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionResourceSecretSource } from "@open-managed-agents/session-resource-store";
import {
  SESSION_OUTPUTS_PATH,
  sessionMemoryResourceFact,
  sessionResourceEnvironment,
  sessionResourceFacts,
  sessionResourceReminders,
  sessionSkillResourceFact,
  sessionSkillVersionRoot,
  type SessionMemoryResourceFact,
  type SessionResourceReminder,
  type SessionSkillResourceFact,
} from "@open-managed-agents/runtime-resource-contract";
import type { NodeManagedMemorySnapshotPort } from "./node-managed-memory-snapshots.js";
import {
  materializeNodeManagedMemoryStores,
  nodeManagedMemoryStoreName,
} from "./node-managed-memory-stores.js";
import {
  resolveAppendablePrompts, type SkillMountDescriptor, resolveSkillAssemblyConfig,
  skillMountsShouldFetchBodies,
} from "@open-managed-agents/agent-harness";
import { toLegacyHarnessAgentConfig } from "./node-managed-agent-codec.js";
import { clonesAnonymously, repositoryToken } from "./node-repository-egress.js";

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
): Promise<{ version: string; name: string; description: string; directory: string } | undefined> {
  if (requestedVersion === "latest") {
    const listed = await skillVersions.listSkillVersions({ skillId, pageSize: 1 });
    if (listed.type !== "page" || listed.page.versions.length === 0) return undefined;
    const view = listed.page.versions[0]!;
    return {
      version: view.version,
      name: view.name,
      description: view.description,
      directory: view.directory,
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
    directory: retrieved.version.directory,
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
  /** Unset: repositories without a token are cloned anonymously. */
  repositoryBonds?: RepositoryBondCredentialSource;
  /** What git authenticates with instead of the token; the egress relay
   * substitutes it (node-repository-egress). Unset: credentialed
   * repositories are refused, never written in plaintext. */
  repositoryPlaceholder?(input: { workspaceId: string; sessionId: string; resourceId: string }): Promise<string>;
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

/** Host-materialized root of one custom Skill version; {@link
 * NodeManagedSessionInputPreparer.prepareInputs} writes the archive below it. */
function nodeManagedSkillVersionRoot(skillId: string, requestedVersion: string): string {
  return sessionSkillVersionRoot(skillId, requestedVersion, `${PLATFORM_ROOT}/skills`);
}

/** Skill facts for the custom Skills prepareInputs materializes: the
 * compiled package roots every archive entry under its `directory`, so the
 * manifest the sandbox holds is `<version root>/<directory>/SKILL.md`. */
export async function resolveNodeManagedSkillFacts(
  session: Session,
  skillVersions: SkillVersionSource,
): Promise<SessionSkillResourceFact[]> {
  const facts: SessionSkillResourceFact[] = [];
  for (const skill of session.agent.skills) {
    if (skill.type !== "custom") continue;
    const requestedVersion = skill.version ?? "latest";
    const resolved = await resolveConcreteSkillVersion(skillVersions, skill.skillId, requestedVersion);
    if (!resolved) continue;
    facts.push(sessionSkillResourceFact({
      skillId: skill.skillId,
      name: resolved.name,
      manifestPath: `${nodeManagedSkillVersionRoot(skill.skillId, requestedVersion)}/${resolved.directory}/SKILL.md`,
    }));
  }
  return facts;
}

/** Memory facts for the stores prepareStorage attaches: file sync and native
 * mounts both place a store at `/mnt/memory/<nodeManagedMemoryStoreName>`. */
export function nodeManagedMemoryFacts(session: Session): SessionMemoryResourceFact[] {
  return session.resources
    .filter((resource) => resource.type === "memory_store")
    .map((resource) => sessionMemoryResourceFact({
      storeId: resource.memoryStoreId,
      storeName: nodeManagedMemoryStoreName(resource),
      access: resource.access === "read_only" ? "read_only" : "read_write",
      description: resource.description ?? null,
      instructions: resource.instructions ?? null,
    }));
}

/** Model-visible Session resource guidance for a Node turn. Outputs are
 * always attached (prepareStorage) and already stated by the platform
 * guidance composeSystemPrompt adds; assembly harnesses expose Skill
 * locations through their own skill mounts. */
export async function buildNodeManagedResourceReminders(
  session: Session,
  skillVersions: SkillVersionSource,
  options: { skills: boolean; workspaceRoot?: string; materializedSkills?: readonly SessionSkillResourceFact[] },
): Promise<SessionResourceReminder[]> {
  const facts = sessionResourceFacts({
    workspaceRoot: options.workspaceRoot,
    skills: options.skills ? (options.materializedSkills ?? await resolveNodeManagedSkillFacts(session, skillVersions)) : [],
    memoryStores: nodeManagedMemoryFacts(session),
    outputs: { path: SESSION_OUTPUTS_PATH },
  });
  return sessionResourceReminders(facts, { outputsGuidedByPlatform: true, includeWorkspace: options.workspaceRoot !== undefined });
}

/** @deprecated Prefer {@link resolveNodeManagedSkillMounts} for assembly harnesses. */
export function buildNodeManagedSkillMounts(
  session: Session,
  skillVersions: SkillVersionSource,
): Promise<SkillMountDescriptor[]> {
  return resolveNodeManagedSkillMounts(session, skillVersions);
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
    const resolved = await resolveConcreteSkillVersion(
      skillVersions,
      skill.skillId,
      requestedVersion,
    );
    if (!resolved) continue;
    const mountRoot = `${nodeManagedSkillVersionRoot(skill.skillId, requestedVersion)}/${resolved.directory}/`;

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

// Facts are retained with the prepared runtime, never re-resolved from a mutable
// `latest` catalog entry when the model prompt is built.
const materializedSkillFacts = new WeakMap<SandboxExecutor, readonly SessionSkillResourceFact[]>();
export function preparedNodeManagedSkillFacts(sandbox: SandboxExecutor): readonly SessionSkillResourceFact[] {
  const facts = materializedSkillFacts.get(sandbox);
  if (facts === undefined) throw new Error("Managed Session Skill facts are unavailable before input preparation");
  return facts;
}

/** Materializes the immutable inputs needed by the in-process Node harness.
 * This is deliberately an injected adapter: the runner owns ordering while
 * Files/Skills storage and sandbox I/O stay behind their existing ports. */
export class NodeManagedSessionInputPreparer {
  constructor(
    private readonly dependencies: NodeManagedSessionInputPreparerDependencies,
  ) {}

  async prepare(input: PrepareNodeManagedSessionInputs): Promise<void> {
    await this.prepareStorage(input);
    await this.prepareInputs(input);
  }

  /** Session outputs and Memory Stores: what the sandbox storage Port
   * attaches on every open (design §0.1 step 3). */
  async prepareStorage(input: PrepareNodeManagedSessionInputs): Promise<void> {
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
    await input.sandbox.setEnvVars?.(sessionResourceEnvironment({ memoryStores: [], outputs: { path: SESSION_OUTPUTS_PATH } }));

    await this.prepareMemoryStores(input);

    if (this.dependencies.sharedOutputs) {
      const command = `mkdir -p ${SESSION_OUTPUTS_PATH}`;
      assertCommandSucceeded(command, await input.sandbox.exec(command, 30_000));
    }
  }

  /** Session init after storage (design §0.1 step 3): repositories, files
   * and custom skills. */
  async prepareInputs(input: PrepareNodeManagedSessionInputs): Promise<void> {
    materializedSkillFacts.delete(input.sandbox);
    const skills: SessionSkillResourceFact[] = [];

    await mountSessionResources(input.sandbox, input.session.resources, {
      downloadFile: async (fileId) => {
        const downloaded = await this.dependencies.files.downloadFile({ fileId });
        if (downloaded.type !== "found") throw new Error(`Managed Session file ${fileId} was not found`);
        return downloaded.file.content;
      },
      // git authenticates with a placeholder; only the egress relay holds the
      // token (node-repository-egress). No placeholder source: refused, never plaintext.
      repositories: commandScopedRepositoryAccess(input.sandbox, (repository) => this.repositoryPlaceholder(input, repository), (repository) => clonesAnonymously(this.dependencies, repository)),
      // Attached by the sandbox storage Port on every open (prepareStorage).
      memoryStores: { mode: "storage" },
    });

    const writeFileBytes = input.sandbox.writeFileBytes;
    const needsSkillWrites = input.session.agent.skills.some((skill) => skill.type === "custom");
    if (needsSkillWrites && writeFileBytes === undefined) {
      throw new Error("Managed Session inputs require sandbox binary file writes");
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
          `${nodeManagedSkillVersionRoot(skill.skillId, requestedVersion)}/${path}`,
          content,
        );
        if (posix.basename(path) === "SKILL.md") skills.push(sessionSkillResourceFact({
          skillId: skill.skillId,
          manifestPath: `${nodeManagedSkillVersionRoot(skill.skillId, requestedVersion)}/${path}`,
        }));
      }
      if (!foundManifest) {
        throw new Error(
          `Managed Skill ${skill.skillId}@${concreteVersion} archive has no SKILL.md`,
        );
      }
    }
    materializedSkillFacts.set(input.sandbox, skills);
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
    await input.sandbox.setEnvVars?.(sessionResourceEnvironment({
      memoryStores: nodeManagedMemoryFacts(input.session),
      outputs: null,
    }));
  }

  /** What git sends for `resource`: its placeholder, once the token it
   * stands for is known to exist (the relay substitutes it on the repository's host). */
  private async repositoryPlaceholder(
    input: PrepareNodeManagedSessionInputs,
    resource: RepositoryMount,
  ): Promise<string | null> {
    if (resource.id === undefined) return null;
    const scope = { workspaceId: input.workspaceId, sessionId: input.session.id };
    const token = await repositoryToken(this.dependencies, scope, resource as Parameters<typeof repositoryToken>[2]);
    if (token === null) return null;
    if (this.dependencies.repositoryPlaceholder === undefined) {
      throw new Error("Managed Session GitHub repositories need credential egress (PLATFORM_ROOT_SECRET); the token is never written to the sandbox");
    }
    return this.dependencies.repositoryPlaceholder({ ...scope, resourceId: resource.id });
  }
}
