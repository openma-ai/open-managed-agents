// Session resource facts: the one place where the sandbox-visible layout of
// Session resources (workspace root, Skill directories, Memory Store mounts
// and the Session outputs directory) is turned into the env values and the
// model-visible guidance every host and in-sandbox harness emits.
//
// Hosts resolve facts from what they actually materialized or mounted (a
// Memory Store's resolved store name and access, the absolute path of a
// SKILL.md they wrote, whether the outputs directory is attached) and pass
// them here. Platform adapters keep doing the real IO; nothing in this module
// performs any. Environment variables are NOT model visibility: a harness
// that wants the model to use a resource must put
// `sessionResourceReminders(facts)` into the prompt it actually sends.
//
// Self-contained on purpose (no imports): the in-sandbox supervisor and every
// host share it without pulling in host-only packages.

/** Protocol working directory of a managed sandbox. Repositories without an
 * explicit mount path are checked out here. */
export const SESSION_WORKSPACE_ROOT = "/workspace";

/** Parent of every attached Memory Store mount (`/mnt/memory/<store>`). */
export const SESSION_MEMORY_ROOT = "/mnt/memory";

/** Session outputs directory; collected after execution and downloadable
 * through the Session outputs/Files API. */
export const SESSION_OUTPUTS_PATH = "/mnt/session/outputs";

/** Host-materialized canonical Skill root (`/oma/skills/<id>/<version>/…`). */
export const SESSION_SKILLS_ROOT = "/oma/skills";

export type SessionMemoryAccess = "read_write" | "read_only";

export interface SessionSkillResourceFact {
  skillId: string;
  /** Display name; falls back to the id in guidance when empty. */
  name: string;
  /** Absolute path of the SKILL.md the runtime actually wrote. */
  manifestPath: string;
  /** Directory containing SKILL.md; relative paths in SKILL.md resolve here. */
  directory: string;
}

export interface SessionMemoryResourceFact {
  storeId: string;
  /** Store name shown to the model and used for the `OMA_MEMORY_<NAME>` key. */
  storeName: string;
  /** Absolute directory the runtime actually mounted/materialized the store
   * at. Session hosts mount by name (`${SESSION_MEMORY_ROOT}/${storeName}`);
   * Environment Work materializes at the resource's published `mount_path`. */
  path: string;
  access: SessionMemoryAccess;
  description?: string;
  instructions?: string;
}

export interface SessionOutputResourceFact {
  /** Directory the runtime collects as Session outputs. */
  path: string;
}

export interface SessionResourceFacts {
  workspaceRoot: string;
  skills: readonly SessionSkillResourceFact[];
  memoryStores: readonly SessionMemoryResourceFact[];
  /** null: this runtime attaches/collects no Session outputs directory. */
  outputs: SessionOutputResourceFact | null;
}

export interface SessionResourceReminder {
  source: string;
  text: string;
}

function assertAbsolute(path: string, what: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").some((segment) => segment === "..")) {
    throw new Error(`${what} must be an absolute path without '..': ${path}`);
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/u, "") : path;
}

/** Absolute mount path of a Memory Store mounted under `storeName`. Throws
 * when the name cannot be a single directory entry, so a host never
 * advertises a path that the sandbox mount could not have created. */
export function sessionMemoryStorePath(storeName: string): string {
  if (
    storeName.length === 0 || storeName === "." || storeName === ".."
    || storeName.includes("/") || storeName.includes("\\") || storeName.includes("\0")
  ) {
    throw new Error(`Memory Store name cannot be mounted as a directory: ${JSON.stringify(storeName)}`);
  }
  return `${SESSION_MEMORY_ROOT}/${storeName}`;
}

/** Fact for one attached Memory Store. `path` is where the runtime actually
 * put it; omit it only when the store was mounted by name under
 * {@link SESSION_MEMORY_ROOT} (CF SessionDO, Node Session hosts). */
export function sessionMemoryResourceFact(input: {
  storeId: string;
  storeName: string;
  path?: string | null;
  access?: SessionMemoryAccess | null;
  description?: string | null;
  instructions?: string | null;
}): SessionMemoryResourceFact {
  let path: string;
  if (input.path === undefined || input.path === null) {
    path = sessionMemoryStorePath(input.storeName);
  } else {
    path = trimTrailingSlash(input.path);
    assertAbsolute(path, "Memory Store mount path");
    if (path === "/") throw new Error("Memory Store mount path must be a dedicated directory");
  }
  return {
    storeId: input.storeId,
    storeName: input.storeName,
    path,
    access: input.access === "read_only" ? "read_only" : "read_write",
    ...(input.description ? { description: input.description } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
  };
}

/** Root a host materializes one Skill version under (archive paths are
 * written below it). `root` defaults to {@link SESSION_SKILLS_ROOT}; an
 * in-sandbox materializer passes the root it actually wrote to. */
export function sessionSkillVersionRoot(
  skillId: string,
  requestedVersion: string,
  root: string = SESSION_SKILLS_ROOT,
): string {
  assertAbsolute(root, "Skill root");
  return `${trimTrailingSlash(root)}/${encodeURIComponent(skillId)}/${encodeURIComponent(requestedVersion)}`;
}

/** Fact for a Skill whose SKILL.md was written at `manifestPath`. */
export function sessionSkillResourceFact(input: {
  skillId: string;
  name?: string | null;
  manifestPath: string;
}): SessionSkillResourceFact {
  assertAbsolute(input.manifestPath, "Skill manifest");
  if (!input.manifestPath.endsWith("/SKILL.md")) {
    throw new Error(`Skill manifest must be a SKILL.md file: ${input.manifestPath}`);
  }
  return {
    skillId: input.skillId,
    name: input.name ?? "",
    manifestPath: input.manifestPath,
    directory: input.manifestPath.slice(0, -"/SKILL.md".length),
  };
}

export function sessionResourceFacts(input: {
  workspaceRoot?: string;
  skills?: readonly SessionSkillResourceFact[];
  memoryStores?: readonly SessionMemoryResourceFact[];
  outputs?: SessionOutputResourceFact | null;
}): SessionResourceFacts {
  const workspaceRoot = trimTrailingSlash(input.workspaceRoot ?? SESSION_WORKSPACE_ROOT);
  assertAbsolute(workspaceRoot, "Workspace root");
  const outputs = input.outputs === undefined || input.outputs === null
    ? null
    : { path: trimTrailingSlash(input.outputs.path) };
  if (outputs !== null) assertAbsolute(outputs.path, "Session outputs path");
  const seen = new Set<string>();
  for (const store of input.memoryStores ?? []) {
    assertAbsolute(store.path, "Memory Store mount path");
    for (const other of seen) {
      if (other === store.path || other.startsWith(`${store.path}/`) || store.path.startsWith(`${other}/`)) {
        throw new Error(`Memory Store mounts overlap: ${other} and ${store.path}`);
      }
    }
    seen.add(store.path);
  }
  return {
    workspaceRoot,
    skills: [...(input.skills ?? [])],
    memoryStores: [...(input.memoryStores ?? [])],
    outputs,
  };
}

/** Env key carrying one Memory Store's mount path. */
export function sessionMemoryEnvKey(storeName: string): string {
  return `OMA_MEMORY_${storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Env values derived from the facts (`OMA_MEMORY_DIR`, `OMA_MEMORY_<NAME>`,
 * `OMA_OUTPUTS_DIR`). Only resources present in the facts produce keys. */
export function sessionResourceEnvironment(
  facts: Pick<SessionResourceFacts, "memoryStores" | "outputs">,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (facts.memoryStores.length > 0) env.OMA_MEMORY_DIR = SESSION_MEMORY_ROOT;
  for (const store of facts.memoryStores) env[sessionMemoryEnvKey(store.storeName)] = store.path;
  if (facts.outputs !== null) env.OMA_OUTPUTS_DIR = facts.outputs.path;
  return env;
}

/** Replace the managed resource namespace when composing a complete agent
 * environment. The patch-only helper above is also used during incremental
 * mounts, where clearing other mounts would be incorrect. Undefined explicitly
 * removes inherited values at the process transport boundary. */
export function reconcileSessionResourceEnvironment(
  facts: Pick<SessionResourceFacts, "memoryStores" | "outputs">,
  inherited: Readonly<Record<string, string | undefined>>,
  ambientKeys: readonly string[] = [],
): Record<string, string | undefined> {
  const env = { ...inherited };
  for (const key of [...Object.keys(env), ...ambientKeys]) {
    if (key === "OMA_OUTPUTS_DIR" || key.startsWith("OMA_MEMORY_")) env[key] = undefined;
  }
  return { ...env, ...sessionResourceEnvironment(facts) };
}

export function sessionMemoryReminder(store: SessionMemoryResourceFact): SessionResourceReminder {
  const lines = [
    `## Memory store: ${store.storeName}`,
    `Mounted at ${store.path}/ (${store.access === "read_only" ? "read-only" : "read-write"})`,
  ];
  if (store.description) lines.push(store.description);
  if (store.instructions) lines.push(store.instructions);
  if (store.access === "read_only") {
    lines.push("(read-only mount — write attempts to this directory will fail)");
  }
  return { source: `memory:${store.storeId}`, text: lines.join("\n") };
}

export function sessionSkillReminder(skill: SessionSkillResourceFact): SessionResourceReminder {
  const label = skill.name || skill.skillId;
  return {
    source: `skill_files:${skill.skillId}`,
    text: [
      `Skill "${label}" files are installed at ${skill.directory}/ (manifest: ${skill.manifestPath}).`,
      `Relative paths in its SKILL.md, including bundled scripts, resolve against ${skill.directory}/; run bundled scripts from that directory (for example \`cd '${skill.directory}' && <command from SKILL.md>\`).`,
    ].join("\n"),
  };
}

export function sessionOutputsReminder(outputs: SessionOutputResourceFact): SessionResourceReminder {
  return {
    source: "session_outputs",
    text: `Files you write under \`${outputs.path}/\` persist after the session ends and are downloadable by the user. Use this path for final artifacts the user should keep. Files written anywhere else are scratch and are not collected as Session outputs.`,
  };
}

export interface SessionResourceReminderOptions {
  /** Set by hosts whose prompt already carries the platform outputs guidance
   * (`@open-managed-agents/agent-harness` `composeSystemPrompt`) for the same
   * {@link SESSION_OUTPUTS_PATH}, so the same instruction is not sent twice. */
  outputsGuidedByPlatform?: boolean;
  /** Include when the caller resolved the runtime workspace, not a guessed default. */
  includeWorkspace?: boolean;
}

/** Model-visible guidance for the facts, in a stable order: Skill locations,
 * Memory Stores, then outputs. Byte-stable for equal facts (prompt cache). */
export function sessionResourceReminders(
  facts: SessionResourceFacts,
  options: SessionResourceReminderOptions = {},
): SessionResourceReminder[] {
  const reminders = [
    ...(options.includeWorkspace ? [{ source: "session_workspace", text: `The session workspace is ${facts.workspaceRoot}/. Resolve task-relative paths from this workspace unless a Skill specifies its own directory.` }] : []),
    ...facts.skills.map(sessionSkillReminder),
    ...facts.memoryStores.map(sessionMemoryReminder),
  ];
  if (facts.outputs !== null) {
    const platformCovers = options.outputsGuidedByPlatform === true && facts.outputs.path === SESSION_OUTPUTS_PATH;
    if (!platformCovers) reminders.push(sessionOutputsReminder(facts.outputs));
  }
  return reminders;
}
