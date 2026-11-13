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
  /** Directory name under {@link SESSION_MEMORY_ROOT} the store is mounted as. */
  storeName: string;
  /** Absolute mount path, always `${SESSION_MEMORY_ROOT}/${storeName}`. */
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

export function sessionMemoryResourceFact(input: {
  storeId: string;
  storeName: string;
  access?: SessionMemoryAccess | null;
  description?: string | null;
  instructions?: string | null;
}): SessionMemoryResourceFact {
  return {
    storeId: input.storeId,
    storeName: input.storeName,
    path: sessionMemoryStorePath(input.storeName),
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
    if (store.path !== sessionMemoryStorePath(store.storeName)) {
      throw new Error(`Memory Store ${store.storeId} path ${store.path} is not where ${store.storeName} mounts`);
    }
    if (seen.has(store.path)) throw new Error(`Two Memory Stores mount at ${store.path}`);
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
}

/** Model-visible guidance for the facts, in a stable order: Skill locations,
 * Memory Stores, then outputs. Byte-stable for equal facts (prompt cache). */
export function sessionResourceReminders(
  facts: SessionResourceFacts,
  options: SessionResourceReminderOptions = {},
): SessionResourceReminder[] {
  const reminders = [
    ...facts.skills.map(sessionSkillReminder),
    ...facts.memoryStores.map(sessionMemoryReminder),
  ];
  if (facts.outputs !== null) {
    const platformCovers = options.outputsGuidedByPlatform === true && facts.outputs.path === SESSION_OUTPUTS_PATH;
    if (!platformCovers) reminders.push(sessionOutputsReminder(facts.outputs));
  }
  return reminders;
}
