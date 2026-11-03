import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadBetterSqlite3, type BetterSqlite3Constructor } from "../src/lib/better-sqlite3.js";

const fakeCtor = function FakeDatabase() {} as unknown as BetterSqlite3Constructor;

function missing(code: string): Error {
  return Object.assign(new Error(`Cannot find package 'better-sqlite3'`), { code });
}

describe("loadBetterSqlite3", () => {
  it("returns the driver constructor when the module is installed", async () => {
    await expect(loadBetterSqlite3(async () => ({ default: fakeCtor }))).resolves.toBe(fakeCtor);
  });

  it("loads the real driver in this workspace (it stays installed by default)", async () => {
    const Ctor = await loadBetterSqlite3();
    const db = new Ctor(":memory:");
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 });
    db.close();
  });

  it.each(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"])(
    "explains how to fix a missing install (%s)",
    async (code) => {
      const cause = missing(code);
      const err = await loadBetterSqlite3(async () => Promise.reject(cause)).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/optional dependency 'better-sqlite3'/);
      expect((err as Error).message).toMatch(/DATABASE_URL/);
      expect((err as Error).cause).toBe(cause);
    },
  );

  it("explains a package that is present without its compiled addon", async () => {
    const cause = new Error("Could not locate the bindings file. Tried: ...better_sqlite3.node");
    const err = await loadBetterSqlite3(async () => Promise.reject(cause)).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not installed or failed to build/);
    expect((err as Error).cause).toBe(cause);
  });

  it("rethrows unrelated errors unchanged", async () => {
    const boom = new Error("boom");
    await expect(loadBetterSqlite3(async () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("package manifests", () => {
  it.each(["../package.json"])(
    "%s keeps better-sqlite3 optional",
    (rel) => {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      expect(pkg.dependencies?.["better-sqlite3"]).toBeUndefined();
      expect(pkg.optionalDependencies?.["better-sqlite3"]).toBeDefined();
    },
  );
});
