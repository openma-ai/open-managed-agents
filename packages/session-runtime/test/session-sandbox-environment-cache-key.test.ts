import { describe, expect, it } from "vitest";
import { environmentCacheKey } from "../src/session-sandbox-environment-cache-key";

const base = { adapter: "e2b", image: "img@sha256:1", packages: { pip: ["pandas"], apt: ["jq"] }, acp: null, setupVersion: "fixed" };

describe("environmentCacheKey", () => {
  it("is the SHA-256 hex every runtime computes for the same input", async () => {
    await expect(environmentCacheKey(base)).resolves.toBe("6e1857bb5150be4b68d470e7db05ee115069122e1b531ae4f0417f62eed725b1");
  });

  it("does not depend on the field order of the package map", async () => {
    await expect(environmentCacheKey(base)).resolves.toBe(await environmentCacheKey({ ...base, packages: { apt: ["jq"], pip: ["pandas"] } }));
  });

  it("changes with the adapter, image digest, alias, packages, order, pip index, ACP pin and setup version", async () => {
    const keys = await Promise.all([
      base,
      { ...base, adapter: "other" },
      { ...base, image: "img@sha256:2" },
      { ...base, imageAlias: "analytics" },
      { ...base, packages: { pip: ["numpy"], apt: ["jq"] } },
      { ...base, packages: { pip: ["pandas", "numpy"], apt: ["jq"] } },
      { ...base, packages: { pip: ["numpy", "pandas"], apt: ["jq"] } },
      { ...base, pipIndexUrl: "https://mirror.example/simple" },
      { ...base, acp: { package: "p", version: "1", nodeMajor: 22 } },
      { ...base, setupVersion: "next" },
    ].map((input) => environmentCacheKey(input)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is null with nothing to cache, and never carries the pip index", async () => {
    await expect(environmentCacheKey({ adapter: "e2b", image: "base", acp: null })).resolves.toBeNull();
    await expect(environmentCacheKey({ adapter: "e2b", image: "base", packages: { gem: ["rails"] }, acp: null })).resolves.toBeNull();
    expect(await environmentCacheKey({ ...base, pipIndexUrl: "https://user:secret@m.example/" })).not.toContain("secret");
  });
});
