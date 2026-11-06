import { describe, expect, it } from "vitest";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import type { EvalRunRow } from "@open-managed-agents/evals-store";
import {
  benchmarkToApi,
  EvalBenchmarkError,
  EvalBenchmarkStore,
  messagesCaseSpec,
  parseMessagesCase,
  type StoredMessagesCase,
} from "../src/benchmarks";
import { extractResults, recordToApi, rowToRecord } from "../src/types";

const noAlias = () => null;

describe("EvalBenchmarkStore (messages)", () => {
  it("creates, adds, replaces and deletes cases; names conflict with 409", async () => {
    const store = new EvalBenchmarkStore(new InMemoryKvStore(), "t");
    const created = await store.create({ name: "chat", kind: "messages", cases: [parseMessagesCase({ name: "a", messages: ["hi"] }) as StoredMessagesCase] });
    expect(created.id).toMatch(/^evbm_/);
    expect(benchmarkToApi(created, noAlias, true)).toMatchObject({ kind: "messages", source: null, case_count: 1, runnable_count: 1, cases: [{ kind: "messages", name: "a", messages: ["hi"] }] });

    await store.addMessagesCase(created.id, parseMessagesCase({ name: "b", messages: ["x", "y"], reward: { type: "verifiable", check: "x" } }));
    await expect(store.addMessagesCase(created.id, parseMessagesCase({ name: "b", messages: ["z"] }))).rejects.toMatchObject({ status: 409 });

    const { name: _name, ...content } = parseMessagesCase({ name: "ignored", messages: ["new"] }, "a");
    const replaced = await store.replaceMessagesCase(created.id, "a", content);
    expect(replaced).toMatchObject({ name: "a", messages: ["new"] });
    await expect(store.replaceMessagesCase(created.id, "nope", content)).rejects.toMatchObject({ status: 404 });

    await store.deleteCase(created.id, "b");
    const after = (await store.get(created.id))!;
    expect(after.cases.map((entry) => entry.name)).toEqual(["a"]);
    expect(after.updated_at >= after.created_at).toBe(true);

    expect((await store.rename(created.id, "renamed"))!.name).toBe("renamed");
    await expect(store.addHarborCases(created.id, [])).rejects.toThrow(/messages benchmark/);
    expect(await store.delete(created.id)).toBe(true);
    expect(await store.get(created.id)).toBeNull();
  });

  it("validates messages case input", () => {
    expect(() => parseMessagesCase({ name: "bad name", messages: ["x"] })).toThrow(EvalBenchmarkError);
    expect(() => parseMessagesCase({ name: "a", messages: [] })).toThrow(/non-empty messages/);
    expect(() => parseMessagesCase({ name: "a", messages: ["x"], reward: { type: "nope" } })).toThrow(/reward.type/);
    expect(() => parseMessagesCase({ name: "a", messages: ["x"], setup_files: [{ path: "rel", content: "" }] })).toThrow(/absolute/);
    expect(() => parseMessagesCase({ name: "a", messages: ["x"], timeout_ms: 0 })).toThrow(/timeout_ms/);
    const parsed = parseMessagesCase({ name: "a", messages: ["x"], setup_script: "true", timeout_ms: 5, extra: 1 });
    expect(parsed).toEqual({ kind: "messages", name: "a", messages: ["x"], setup_script: "true", timeout_ms: 5 });
    expect(messagesCaseSpec({ ...parsed, updated_at: "" })).toEqual({ id: "a", messages: ["x"], setup_script: "true", timeout_ms: 5 });
  });
});

describe("compatibility with records written before the rename", () => {
  it("reads a stored dataset without kind as a harbor benchmark", async () => {
    const kv = new InMemoryKvStore();
    await kv.put("t:t:evaldataset:evds_old", JSON.stringify({
      id: "evds_old", name: "old", source: { type: "builtin", name: "x" }, created_at: "2026-01-01T00:00:00.000Z",
      tasks: [{ name: "a", image: "img/a:1", supported: true, agent_timeout_sec: 60, verifier_timeout_sec: 600, cpus: null, memory_mb: null, has_solution: true, instruction_preview: "do a" }],
    }));
    const store = new EvalBenchmarkStore(kv, "t");
    const benchmark = (await store.get("evds_old"))!;
    expect(benchmark).toMatchObject({ kind: "harbor", updated_at: "2026-01-01T00:00:00.000Z", cases: [{ kind: "harbor", name: "a", updated_at: "2026-01-01T00:00:00.000Z" }] });
    expect(benchmarkToApi(benchmark, () => "a", false)).toMatchObject({ case_count: 1, runnable_count: 1 });
    expect((await store.list()).map((entry) => entry.id)).toEqual(["evds_old"]);
  });

  it("maps a stored run's dataset_id to benchmark_id and writes benchmark_id back", () => {
    const row: EvalRunRow = {
      id: "evrun-1", tenant_id: "t", agent_id: "", environment_id: "", suite: "old", status: "completed",
      started_at: "2026-01-01T00:00:00.000Z", completed_at: null, score: null, error: null,
      results: { kind: "harbor", agent_id: null, environment_id: null, dataset_id: "evds_old", task_count: 0, completed_count: 0, failed_count: 0, tasks: [] },
    };
    const record = rowToRecord(row);
    expect(record.benchmark_id).toBe("evds_old");
    expect(recordToApi(record).benchmark_id).toBe("evds_old");
    expect(extractResults(record)).toMatchObject({ benchmark_id: "evds_old" });
    expect(extractResults(record)).not.toHaveProperty("dataset_id");
  });
});
