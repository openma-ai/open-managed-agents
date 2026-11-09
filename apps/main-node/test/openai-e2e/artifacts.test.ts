import { writeFile, stat } from "node:fs/promises";
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_EXECUTION_LEASE_TTL_MS } from "@open-managed-agents/session-runtime";
import { bootOpenAINode, type OpenAINodeProcess } from "../_helpers/openai-node-process";

const fixtures: OpenAINodeProcess[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose(); });
const path = "/workspace/outputs/artifact-repro.bin";
const bytes = new Uint8Array([0, 255, 254, 13, 10, 65]);

describe("Artifact publication through the Node service and official SDK", () => {
  it("executes a real file write, publishes nonempty artifacts, downloads binary bytes and survives process restart", async () => {
    const f = await bootOpenAINode(input => {
      const blocks = input.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
      if (!blocks.some((block: any) => block.type === "tool_result")) return {
        name: "bash", input: { command: "mkdir -p /workspace/outputs && printf '\\000\\377\\376\\015\\012A' > /workspace/outputs/artifact-repro.bin && echo FILE_WRITTEN" },
      };
      expect(JSON.stringify(blocks)).toContain("FILE_WRITTEN");
      return { text: "ARTIFACT_DONE" };
    }, { localSandbox: true });
    fixtures.push(f);
    const api = f.client.beta.agents;
    const session = await api.sessions.create({
      agent: { model: "claude-sonnet-4-20250514", instructions: "Write the requested binary file using bash." },
      environment: { type: "openai_hosted" }, input: "Write artifact-repro.bin",
    });
    await expect.poll(async () => (await api.sessions.turns.list(session.id)).data[0]?.status, { timeout: 30_000 }).toBe("completed");
    const view = await api.sessions.retrieve(session.id);
    if (!view.environment || !("id" in view.environment)) throw new Error("Expected a connected sandbox");
    const files = await api.environments.files.list(view.environment!.id, { path: "/workspace/outputs" });
    expect(files.data).toContainEqual(expect.objectContaining({ path, size_bytes: 6 }));
    await expect.poll(async () => (await api.sessions.artifacts.list(session.id)).data.length, { timeout: 15_000 }).toBe(1);
    const [artifact] = (await api.sessions.artifacts.list(session.id)).data;
    const [turn] = (await api.sessions.turns.list(session.id)).data;
    expect(artifact).toMatchObject({ path, size_bytes: 6, session_id: session.id, turn_id: turn!.id });
    expect(await api.sessions.artifacts.retrieve(artifact!.id, { session_id: session.id })).toEqual(artifact);
    const download = await api.sessions.artifacts.content(artifact!.id, { session_id: session.id });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(JSON.stringify((await api.sessions.items.list(session.id)).data)).toContain("ARTIFACT_DONE");
    expect(f.requests).toHaveLength(2);
    await f.restart();
    const restored = f.client.beta.agents.sessions;
    expect((await restored.artifacts.list(session.id)).data).toEqual([artifact]);
    expect(new Uint8Array(await (await restored.artifacts.content(artifact!.id, { session_id: session.id })).arrayBuffer())).toEqual(bytes);
    expect((await restored.turns.list(session.id)).data).toEqual([turn]);
    expect(f.requests).toHaveLength(2);
    console.info("ARTIFACT_ACCEPTANCE", JSON.stringify({ session_id: session.id, artifact_id: artifact!.id, turn_id: turn!.id, path, hex: Buffer.from(bytes).toString("hex"), restart: true }));
  }, 150_000);
  it("recovers partial publication after SIGKILL without re-running the completed turn", async () => {
    const f = await bootOpenAINode(input => {
      const blocks = input.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
      if (!blocks.some((block: any) => block.type === "tool_result")) return {
        name: "bash", input: { command: "mkdir -p /workspace/outputs && printf 'ARTIFACT_A' > /workspace/outputs/a.txt && printf 'ARTIFACT_B' > /workspace/outputs/b.txt && echo BOTH_WRITTEN" },
      };
      expect(JSON.stringify(blocks)).toContain("BOTH_WRITTEN");
      return { text: "ARTIFACT_CRASH_DONE" };
    }, { localSandbox: true, publicationCrashBarrier: true });
    fixtures.push(f);
    await writeFile(join(f.directory, "publication-crash-arm"), "armed");
    const session = await f.client.beta.agents.sessions.create({
      agent: { model: "claude-sonnet-4-20250514" },
      environment: { type: "openai_hosted" }, input: "Write two files",
    });
    await expect.poll(async () => stat(join(f.directory, "publication-crash-ready")).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
    const api = f.client.beta.agents.sessions;
    const before = (await api.artifacts.list(session.id)).data;
    expect(before).toHaveLength(1);
    const turns = (await api.turns.list(session.id)).data;
    expect(turns).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(f.requests).toHaveLength(2);
    const execution = () => {
      const db = new Database(join(f.directory, "oma.db"), { readonly: true });
      try {
        return db.prepare("SELECT id,state,attempt_id,generation,owner_id,lease_expires_at_ms FROM managed_session_executions WHERE session_id = ? ORDER BY admitted_at_ms DESC LIMIT 1").get(session.id) as {
          id: string; state: string; attempt_id: string; generation: number; owner_id: string; lease_expires_at_ms: number;
        };
      } finally { db.close(); }
    };
    const original = execution();
    expect(original).toMatchObject({ state: "running", generation: 1 });
    // A real SIGKILL ends the server while its second publication read is
    // pending. Restart opens the same on-disk SQLite, Files and workspace.
    await f.restart();
    const restored = f.client.beta.agents.sessions;
    const observations: Array<{ at: number; generation: number; attempt_id: string; state: string }> = [];
    let firstTakeoverAt: number | undefined;
    await expect.poll(() => {
      const row = execution();
      const at = Date.now();
      observations.push({ at, generation: row.generation, attempt_id: row.attempt_id, state: row.state });
      // Keep samples outside assertion retry semantics: an early takeover
      // must remain a failure even if a later sample reaches generation 2.
      if (row.generation > original.generation) firstTakeoverAt ??= at;
      return row.generation;
    }, { timeout: DEFAULT_SESSION_EXECUTION_LEASE_TTL_MS + 20_000, interval: 500 }).toBe(2);
    console.info("ARTIFACT_LEASE_OBSERVATIONS", JSON.stringify({ original, firstTakeoverAt, observations }));
    const beforeExpiry = observations.filter(row => row.at < original.lease_expires_at_ms);
    expect(beforeExpiry.length).toBeGreaterThan(0);
    for (const row of beforeExpiry) {
      expect(row.attempt_id).toBe(original.attempt_id);
      expect(row.generation).toBe(original.generation);
    }
    expect(firstTakeoverAt).toBeGreaterThanOrEqual(original.lease_expires_at_ms);
    expect(execution().attempt_id).not.toBe(original.attempt_id);
    await writeFile(join(f.directory, "publication-lease-observations.json"), JSON.stringify({ original, firstTakeoverAt, observations }));
    // SIGKILL cannot release its lease. Recovery must wait for the shared
    // 90s authority to expire before another attempt can publish.
    await expect.poll(async () => (await restored.artifacts.list(session.id)).data.length, { timeout: DEFAULT_SESSION_EXECUTION_LEASE_TTL_MS + 20_000 }).toBe(2);
    const artifacts = (await restored.artifacts.list(session.id)).data;
    expect(artifacts).toContainEqual(before[0]);
    expect(artifacts.map(a => a.path).sort()).toEqual(["/workspace/outputs/a.txt", "/workspace/outputs/b.txt"]);
    for (const artifact of artifacts) {
      expect(artifact.turn_id).toBe(turns[0]!.id);
      const download = await restored.artifacts.content(artifact.id, { session_id: session.id });
      expect(Buffer.from(await download.arrayBuffer()).toString()).toBe(artifact.path.endsWith("a.txt") ? "ARTIFACT_A" : "ARTIFACT_B");
    }
    expect((await restored.turns.list(session.id)).data).toEqual(turns);
    expect(f.requests).toHaveLength(2);
    await f.restart();
    expect((await f.client.beta.agents.sessions.artifacts.list(session.id)).data).toEqual(artifacts);
    expect(f.requests).toHaveLength(2);
    console.info("ARTIFACT_CRASH_ACCEPTANCE", JSON.stringify({ session_id: session.id, artifact_ids: artifacts.map(a => a.id), turn_id: turns[0]!.id, harness_model_requests: f.requests.length }));
  }, 200_000);

});
