import { describe, expect, it } from "vitest";
import { memoryStoreMountTarget, planSessionResourceMounts } from "../src/session-resource-records";

describe("planSessionResourceMounts", () => {
  it("reads domain camelCase and legacy snake_case records alike", () => {
    expect(planSessionResourceMounts([
      { type: "file", fileId: "f1", mountPath: "/workspace/in.txt" },
      { type: "file", file_id: "f2" },
      { type: "github_repository", id: "r1", url: "https://g/x.git", mountPath: "/workspace/x", credentialSource: "bond" },
      { type: "github_repo", repo_url: "https://g/y.git", checkout: { type: "commit", sha: "abcdef0" } },
      { type: "memory_store", memoryStoreId: "m1", name: "notes", access: "read_only", runtimeMountStoreId: "snap/m1" },
      { type: "memory_store", memory_store_id: "m2", mount_path: "/mnt/memory/x" },
      { type: "env_secret", id: "e1", name: "TOKEN" },
    ])).toEqual([
      { type: "file", fileId: "f1", mountPath: "/workspace/in.txt" },
      { type: "file", fileId: "f2", mountPath: "/mnt/session/uploads/f2" },
      { type: "github_repository", id: "r1", url: "https://g/x.git", mountPath: "/workspace/x", checkout: null, credentialSource: "bond" },
      { type: "github_repository", url: "https://g/y.git", mountPath: "/workspace", checkout: { type: "commit", sha: "abcdef0" } },
      { type: "memory_store", storeId: "m1", mountStoreId: "snap/m1", name: "notes", mountPath: null, readOnly: true },
      { type: "memory_store", storeId: "m2", mountStoreId: "m2", name: null, mountPath: "/mnt/memory/x", readOnly: false },
      { type: "env", id: "e1", name: "TOKEN" },
    ]);
  });

  it.each([
    [{ type: "file", fileId: " " }, /requires file_id/],
    [{ type: "github_repository", url: "" }, /requires a URL/],
    [{ type: "github_repository", url: "u", checkout: { type: "branch", name: "a/" } }, /invalid Git branch/],
    [{ type: "github_repository", url: "u", checkout: { type: "commit", sha: "xyz" } }, /invalid Git commit SHA/],
    [{ type: "github_repository", url: "u", checkout: { type: "tag" } }, /unsupported checkout type/],
    [{ type: "memory_store" }, /requires memory_store_id/],
    [{ type: "env", id: "e" }, /sealed secret value/],
    [{ type: "volume" }, /Unsupported Session resource type: volume/],
  ])("rejects %j", (record, message) => {
    expect(() => planSessionResourceMounts([record as never])).toThrow(message);
  });

  it("plans a pre-start Memory mount only for a named store", () => {
    expect(memoryStoreMountTarget({ type: "memory_store", memoryStoreId: "m", name: "n", runtimeMountStoreId: "s" }))
      .toEqual({ storeName: "n", storeId: "s", readOnly: false });
    expect(memoryStoreMountTarget({ type: "memory_store", memoryStoreId: "m" })).toBeNull();
  });
});
