// Node Session host resource guidance: every location the model is told about
// must be where NodeManagedSessionInputPreparer actually put the bytes.
// Evidence level: real local filesystem (LocalSubprocessSandbox) + in-memory
// Memories/Skill-version application fakes. No model inference; this proves
// host guidance <-> materialization agreement, not agent behaviour.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type { MemoriesApplicationPort, MemoryView, Session } from "@open-managed-agents/managed-agents-application";
import { composeSystemPrompt } from "@open-managed-agents/agent-harness";

import { ZipSkillPackageCompiler } from "../../../packages/managed-agents-adapters-runtime/src/skill-package-compiler.js";
import {
  NodeManagedSessionInputPreparer,
  preparedNodeManagedSkillFacts,
  buildNodeManagedResourceReminders,
  nodeManagedMemoryFacts,
  resolveNodeManagedSkillFacts,
} from "../../../packages/control-plane-node/src/lib/node-managed-session-inputs.js";

const roots: string[] = [];
const sandboxes: LocalSubprocessSandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshSandbox(): Promise<LocalSubprocessSandbox> {
  const root = await mkdtemp(join(tmpdir(), "openma-node-guidance-"));
  roots.push(root);
  const sandbox = new LocalSubprocessSandbox({ workdir: join(root, "sandbox"), outputsRoot: join(root, "outputs") });
  sandboxes.push(sandbox);
  return sandbox;
}

const bytes = (value: string) => new TextEncoder().encode(value);
const sha256 = async (value: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes(value)),
), (b) => b.toString(16).padStart(2, "0")).join("");

/** Memories application keyed by store, so read-only and writable stores stay distinct. */
function memoriesApp(): MemoriesApplicationPort & { documents: Map<string, MemoryView> } {
  const documents = new Map<string, MemoryView>();
  let sequence = 0;
  return {
    documents,
    async listMemories(input: { memoryStoreId: string }) {
      return { type: "page", page: { items: [...documents.values()].filter((m) => m.memoryStoreId === input.memoryStoreId), nextCursor: null } };
    },
    async createMemory({ memoryStoreId, path, content }) {
      const key = `${memoryStoreId}:${path}`;
      if (documents.has(key)) return { type: "conflict" };
      sequence += 1;
      const memory: MemoryView = {
        kind: "memory", id: `mem_${sequence}`, path, content,
        contentSha256: await sha256(content ?? ""), contentSizeBytes: (content ?? "").length,
        memoryStoreId, memoryVersionId: `ver_${sequence}`,
        createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z",
      };
      documents.set(key, memory);
      return { type: "created", memory };
    },
    async retrieveMemory() { return { type: "not_found" }; },
    async updateMemory() { return { type: "not_found" }; },
    async deleteMemory() { return { type: "not_found" }; },
  } as MemoriesApplicationPort & { documents: Map<string, MemoryView> };
}

function session(): Session {
  return {
    id: "session_guidance_01",
    agent: {
      id: "agent_guidance_01", description: null, mcpServers: [], model: { id: "model_guidance" }, multiagent: null,
      name: "Guidance verifier", skills: [{ type: "custom", skillId: "skill_relative", version: "7" }],
      system: "Base system.", tools: [], version: 1,
    },
    archivedAt: null, budget: null, createdAt: "2026-11-13T00:00:00.000Z", environmentId: "env_guidance_01",
    metadata: {}, outcomeEvaluations: [],
    resources: [
      { type: "memory_store", memoryStoreId: "memstore_rw", name: "Team Notes", access: "read_write", description: "Shared notes", instructions: "Check before work." },
      { type: "memory_store", memoryStoreId: "memstore_ro", name: "reference", access: "read_only" },
    ],
    stats: {}, status: "running", title: null, updatedAt: "2026-11-13T00:00:00.000Z", usage: {}, vaultIds: [],
  } as unknown as Session;
}

async function skillVersions() {
  const compiled = await new ZipSkillPackageCompiler().compile({
    files: [
      { filename: "relative-skill/SKILL.md", mimeType: "text/markdown", content: bytes("---\nname: relative-skill\ndescription: Runs a bundled script\n---\nRun `sh scripts/emit.sh`.\n") },
      { filename: "relative-skill/scripts/emit.sh", mimeType: "text/x-shellscript", content: bytes("cat data/value.txt\n") },
      { filename: "relative-skill/data/value.txt", mimeType: "text/plain", content: bytes("SKILL_RELATIVE_OK") },
    ],
  });
  if (compiled.type !== "compiled") throw new Error(compiled.message);
  const view = {
    id: "skv_guidance", createdAt: "2026-11-13T00:00:00.000Z", description: compiled.package.description,
    directory: compiled.package.directory, name: compiled.package.name, skillId: "skill_relative", version: "7",
  };
  return {
    listSkillVersions: async () => ({ type: "page" as const, page: { versions: [view], nextCursor: null } }),
    retrieveSkillVersion: async () => ({ type: "found" as const, version: view }),
    downloadSkillVersion: async () => ({ type: "found" as const, file: { content: compiled.package.archive.content, mimeType: "application/zip" } }),
  };
}

describe("Node Session host resource guidance", () => {
  it("advertises Skill, Memory and outputs locations that hold the materialized bytes", async () => {
    const memories = memoriesApp();
    await memories.createMemory({ memoryStoreId: "memstore_rw", path: "/a.md", content: "rw-canonical" });
    await memories.createMemory({ memoryStoreId: "memstore_ro", path: "/r.md", content: "ro-canonical" });
    const versions = await skillVersions();
    const sandbox = await freshSandbox();
    await new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: versions,
      repositoryCredentials: { findGithubToken: async () => null },
      memoryStores: { mode: "file_sync", memories },
    }).prepare({ workspaceId: "ws", session: session(), sandbox, authorizeMemoryMutation: async () => true });

    const preparedSkills = preparedNodeManagedSkillFacts(sandbox);
    // The catalog can change/unavailable after materialization. Prompt locations
    // must still name the exact bytes already written, without re-resolving latest.
    const unavailableCatalog = {
      ...versions,
      listSkillVersions: async () => { throw new Error("catalog changed after materialization"); },
      retrieveSkillVersion: async () => { throw new Error("catalog changed after materialization"); },
    };
    const reminders = await buildNodeManagedResourceReminders(session(), unavailableCatalog, { skills: true, materializedSkills: preparedSkills });
    expect(reminders.map((r) => r.source)).toEqual(["skill_files:skill_relative", "memory:memstore_rw", "memory:memstore_ro"]);

    // Skill: the advertised directory holds the manifest, and a bundled
    // script's relative path only resolves when run from that directory.
    const [skill] = preparedSkills;
    expect(skill!.directory).toBe("/oma/skills/skill_relative/7/relative-skill");
    expect(reminders[0]!.text).toContain(`resolve against ${skill!.directory}/`);
    await expect(sandbox.readFile(skill!.manifestPath)).resolves.toContain("sh scripts/emit.sh");
    await expect(sandbox.exec(`cd '${skill!.directory}' && sh scripts/emit.sh`)).resolves.toBe("SKILL_RELATIVE_OK");
    // Negative control: same command from the workspace root does not find the script.
    await expect(sandbox.exec("cd /workspace && sh scripts/emit.sh")).resolves.not.toBe("SKILL_RELATIVE_OK");

    // Memory: advertised paths are where file sync put the canonical bytes; env names the same path.
    const [rw, ro] = nodeManagedMemoryFacts(session());
    expect(rw).toMatchObject({ path: "/mnt/memory/Team Notes", access: "read_write" });
    expect(reminders[1]!.text).toBe("## Memory store: Team Notes\nMounted at /mnt/memory/Team Notes/ (read-write)\nShared notes\nCheck before work.");
    expect(reminders[2]!.text).toContain("(read-only mount — write attempts to this directory will fail)");
    await expect(sandbox.readFile(`${rw!.path}/a.md`)).resolves.toBe("rw-canonical");
    await expect(sandbox.readFile(`${ro!.path}/r.md`)).resolves.toBe("ro-canonical");
    await expect(sandbox.exec("cat \"$OMA_MEMORY_TEAM_NOTES/a.md\"")).resolves.toBe("rw-canonical");
    // The read-only claim is true of the materialized directory.
    await expect(sandbox.exec(`printf edit > '${ro!.path}/r.md'`)).resolves.toMatch(/\[exit (exit=)?[1-9]\d*\]/u);
    await expect(sandbox.readFile(`${ro!.path}/r.md`)).resolves.toBe("ro-canonical");

    // Outputs: stated once (platform guidance), and the advertised directory is the collected one.
    const prompt = composeSystemPrompt("Base system.", reminders);
    expect(prompt.split("`/mnt/session/outputs/`").length - 1).toBe(1);
    await expect(sandbox.exec("printf out > \"$OMA_OUTPUTS_DIR/r.txt\" && cat /mnt/session/outputs/r.txt")).resolves.toBe("out");
  });

  it("omits Skill locations for assembly harnesses but keeps Memory guidance", async () => {
    const reminders = await buildNodeManagedResourceReminders(session(), await skillVersions(), { skills: false });
    expect(reminders.map((r) => r.source)).toEqual(["memory:memstore_rw", "memory:memstore_ro"]);
  });

  it("adds no resource guidance for a Session without Skills or Memory", async () => {
    const bare = session();
    bare.resources = [];
    bare.agent.skills = [];
    expect(await buildNodeManagedResourceReminders(bare, await skillVersions(), { skills: true })).toEqual([]);
  });
});
