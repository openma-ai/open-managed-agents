import { describe, expect, it } from "vitest";
import {
  cfSandboxImageCatalog,
  parseCfSandboxImageCatalog,
  resolveCfSandboxImage,
} from "../src/lib/cf-sandbox-images";

const RAW = JSON.stringify({
  "fix-git": {
    reference: "alexgshaw/fix-git:20251031",
    binding: "SANDBOX_FIX_GIT",
    workdir: "/app/",
    label: "fix-git",
  },
  bare: { reference: "registry.example/bare:1", binding: "SANDBOX_BARE" },
});

describe("Cloudflare SANDBOX_IMAGES catalog", () => {
  it("lists aliases only and maps each alias to a container placement", () => {
    const catalog = parseCfSandboxImageCatalog(RAW);
    expect(catalog.list()).toEqual([
      { alias: "fix-git", label: "fix-git", description: null },
      { alias: "bare", label: "bare", description: null },
    ]);
    expect(catalog.get("fix-git")?.reference).toBe("alexgshaw/fix-git:20251031");
    expect(catalog.placement("fix-git")).toEqual({ alias: "fix-git", binding: "SANDBOX_FIX_GIT", workdir: "/app" });
    expect(catalog.placement("bare")).toEqual({ alias: "bare", binding: "SANDBOX_BARE" });
    expect(catalog.has("missing")).toBe(false);
  });

  it("is empty when unset", () => {
    expect(cfSandboxImageCatalog({}).list()).toEqual([]);
    expect(parseCfSandboxImageCatalog("  ").placement("x")).toBeUndefined();
  });

  it.each([
    ["not json", /must be valid JSON/],
    ["[]", /must be a JSON object/],
    [JSON.stringify({ a: { reference: "img:1" } }), /\.binding must name/],
    [JSON.stringify({ a: { reference: "img:1", binding: "bad-name" } }), /\.binding must name/],
    [JSON.stringify({ a: { reference: "img:1", binding: "B", workdir: "app" } }), /\.workdir must be an absolute/],
    [JSON.stringify({ a: { reference: "img:1", binding: "B", workdir: "/a/../b" } }), /\.workdir must be an absolute/],
    // Shared Node rules still apply.
    [JSON.stringify({ a: { binding: "B" } }), /\.reference must be a non-empty string/],
    [JSON.stringify({ a: { reference: "img:1", binding: "B", image: "x" } }), /unknown key "image"/],
    [JSON.stringify({ "Bad Alias": { reference: "img:1", binding: "B" } }), /alias "Bad Alias" must match/],
  ])("rejects %s", (raw, message) => {
    expect(() => parseCfSandboxImageCatalog(raw)).toThrow(message);
  });

  it("resolves at session start and never falls back to the default", () => {
    const catalog = parseCfSandboxImageCatalog(RAW);
    expect(resolveCfSandboxImage(catalog, undefined, "env_1")).toBeUndefined();
    expect(resolveCfSandboxImage(catalog, "bare", "env_1")?.binding).toBe("SANDBOX_BARE");
    expect(() => resolveCfSandboxImage(catalog, "gone", "env_1"))
      .toThrow(/Sandbox image "gone" selected by environment env_1 is not in this deployment's SANDBOX_IMAGES catalog/);
  });
});
