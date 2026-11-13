import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadNodeConfig, NodeConfigError } from "../src/config";
const storage = Object.fromEntries(["MEMORY_S3", "FILES_S3"].flatMap((prefix) => [
  [`${prefix}_ENDPOINT`, "https://storage.invalid"], [`${prefix}_BUCKET`, "test"],
  [`${prefix}_ACCESS_KEY`, "synthetic"], [`${prefix}_SECRET_KEY`, "synthetic"],
]));
describe("container startup contract", () => {
  it("reproduces the Fly true-string failure with both configuration names", () => {
    try {
      loadNodeConfig({ NODE_ENV: "test", ...storage, MEMORY_S3_FORCE_PATH_STYLE: "true", FILES_S3_FORCE_PATH_STYLE: "true" });
      throw new Error("expected startup validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NodeConfigError);
      expect((error as NodeConfigError).problems).toEqual([
        "MEMORY_S3_FORCE_PATH_STYLE must be 0 or 1", "FILES_S3_FORCE_PATH_STYLE must be 0 or 1",
      ]);
    }
  });
  it.each(["0", "1"])("accepts path-style value %s without a network connection", (value) => {
    const config = loadNodeConfig({ NODE_ENV: "test", ...storage, MEMORY_S3_FORCE_PATH_STYLE: value, FILES_S3_FORCE_PATH_STYLE: value });
    expect(config.blobs.memory).toMatchObject({ kind: "s3", forcePathStyle: value === "1" });
    expect(config.blobs.files).toMatchObject({ kind: "s3", forcePathStyle: value === "1" });
  });
  it("uses the repository Node engine major in both container stages", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const major = pkg.engines.node.split(".")[0];
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const stages = [...dockerfile.matchAll(/^FROM node:(\d+)-\S+ AS (deps|runtime)$/gm)];
    expect(stages.map((m) => m[2])).toEqual(["deps", "runtime"]);
    for (const stage of stages) expect(stage[1]).toBe(major);
  });
});
