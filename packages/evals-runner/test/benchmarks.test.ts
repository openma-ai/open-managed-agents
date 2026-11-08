import { describe, expect, it } from "vitest";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import type { HarborTaskBundle } from "@open-managed-agents/harbor-tasks";
import type { EvalRunRow } from "@open-managed-agents/evals-store";
import {
  benchmarkToApi,
  caseDetail,
  EvalBenchmarkError,
  EvalBenchmarkStore,
  messagesCaseSpec,
  parseMessagesCase,
  type CollectedHarborSource,
} from "../src/benchmarks";
import { extractResults, recordToApi, rowToRecord } from "../src/types";

const noAlias = () => null;
const enc = (s: string) => new TextEncoder().encode(s);

function bundle(name: string, instruction = "do " + name): HarborTaskBundle {
  return {
    name,
    root: name,
    files: [
      { path: "task.toml", bytes: enc('[environment]\ndocker_image = "img/' + name + ':1"\n'), executable: false },
      { path: "instruction.md", bytes: enc(instruction), executable: false },
      { path: "tests/test.sh", bytes: enc("#!/bin/bash\n"), executable: true },
    ],
  };
}

function collected(bundles: HarborTaskBundle[], commit = "a".repeat(40)): CollectedHarborSource {
  return {
    defaultName: "set",
    source: { type: "git", url: "https://github.com/o/r" },
    pins: [{ url: "https://github.com/o/r", ref: "HEAD", commit }],
    bundles,
  };
}

describe("EvalBenchmarkStore (messages)", () => {
  it("creates, adds, replaces and deletes cases; names conflict with 409", async () => {
    const store = new EvalBenchmarkStore(new InMemoryKvStore(), "t");
    const created = await store.createMessages("chat", [parseMessagesCase({ name: "a", messages: ["hi"] })]);
    expect(created.id).toMatch(/^evbm_/);
    expect(benchmarkToApi(created, noAlias, true)).toMatchObject({ kind: "messages", source: null, revision: null, case_count: 1, runnable_count: 1, cases: [{ kind: "messages", name: "a", messages: ["hi"] }] });

    await store.addMessagesCase(created.id, parseMessagesCase({ name: "b", messages: ["x", "y"], reward: { type: "verifiable", check: "x" } }));
    await expect(store.addMessagesCase(created.id, parseMessagesCase({ name: "b", messages: ["z"] }))).rejects.toMatchObject({ status: 409 });

    const { name: _name, ...content } = parseMessagesCase({ name: "ignored", messages: ["new"] }, "a");
    const replaced = await store.replaceMessagesCase(created.id, "a", content);
    expect(replaced).toMatchObject({ name: "a", messages: ["new"] });
    await expect(store.replaceMessagesCase(created.id, "nope", content)).rejects.toMatchObject({ status: 404 });

    await store.deleteMessagesCase(created.id, "b");
    const after = (await store.get(created.id))!;
    expect(after.cases.map((entry) => entry.name)).toEqual(["a"]);
    expect((await store.rename(created.id, "renamed"))!.name).toBe("renamed");
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

describe("EvalBenchmarkStore (harbor revisions)", () => {
  it("makes a revision only when content changes and keeps every revision readable by digest", async () => {
    const kv = new InMemoryKvStore();
    const store = new EvalBenchmarkStore(kv, "t");
    const created = await store.createHarbor("set", collected([bundle("alpha"), bundle("beta")]));
    expect(created).toMatchObject({ revision: 1, cases_revision: 1 });
    const first = benchmarkToApi(created, (image) => (image === "img/alpha:1" ? "alpha" : null), true);
    expect(first).toMatchObject({ revision: 1, case_count: 2, runnable_count: 1, cases_revision: 1 });
    expect(first.revisions).toHaveLength(1);
    expect(first.revisions![0]).toMatchObject({ revision: 1, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), pins: [{ commit: "a".repeat(40) }], case_count: 2 });
    const alphaDigest = created.cases[0]!.kind === "harbor" ? created.cases[0]!.digest : "";
    expect(alphaDigest).toMatch(/^sha256:/);

    // Same content from another commit: Harbor publish semantics, nothing written.
    const same = await store.sync(created.id, collected([bundle("beta"), bundle("alpha")], "b".repeat(40)));
    expect(same.changed).toBe(false);
    expect(same.benchmark.revision).toBe(1);

    const changed = await store.sync(created.id, collected([bundle("alpha", "do alpha better"), bundle("beta")], "c".repeat(40)));
    expect(changed.changed).toBe(true);
    expect(changed.benchmark.revision).toBe(2);
    const second = changed.benchmark.cases;
    expect(second[1]).toEqual(created.cases[1]); // beta unchanged: same digest and first-seen time
    expect(second[0]).not.toMatchObject({ digest: alphaDigest });

    const old = (await store.get(created.id, 1))!;
    expect(old.cases_revision).toBe(1);
    expect((await store.loadTask(created.id, "alpha", alphaDigest)).instruction).toBe("do alpha");
    expect((await caseDetail(store, old, old.cases[0]!, noAlias))).toMatchObject({ revision: 1, instruction: "do alpha" });
    await expect(store.get(created.id, 9)).rejects.toMatchObject({ status: 404 });
    await expect(store.addMessagesCase(created.id, parseMessagesCase({ name: "m", messages: ["x"] }))).rejects.toThrow(/read-only/);

    expect((await store.list()).map((entry) => [entry.id, entry.revision, entry.cases.length])).toEqual([[created.id, 2, 0]]);
    expect(await store.delete(created.id)).toBe(true);
    expect((await kv.list({ prefix: "t:t:evaldataset:" })).keys).toEqual([]);
  });
});

describe("run records", () => {
  it("maps a stored run's dataset_id to benchmark_id and keeps revision and digests", () => {
    const row: EvalRunRow = {
      id: "evrun-1", tenant_id: "t", agent_id: "", environment_id: "", suite: "old", status: "completed",
      started_at: "2026-01-01T00:00:00.000Z", completed_at: null, score: null, error: null,
      results: { kind: "harbor", agent_id: null, environment_id: null, dataset_id: "evds_old", benchmark_revision: 3, task_count: 1, completed_count: 0, failed_count: 0,
        tasks: [{ id: "a", status: "pending", trials: [], digest: "sha256:x" }] },
    };
    const record = rowToRecord(row);
    expect(record.benchmark_id).toBe("evds_old");
    expect(recordToApi(record)).toMatchObject({ benchmark_id: "evds_old", benchmark_revision: 3, tasks: [{ digest: "sha256:x" }] });
    expect(extractResults(record)).toMatchObject({ benchmark_id: "evds_old", benchmark_revision: 3 });
    expect(extractResults(record)).not.toHaveProperty("dataset_id");
  });
});
