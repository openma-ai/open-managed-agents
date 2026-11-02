import { describe, expect, it } from "vitest";
import {
  EMPTY_SANDBOX_IMAGE_CATALOG,
  parseSandboxImageCatalog,
  rejectSandboxImageSelection,
  resolveSandboxImage,
  SandboxImageCatalogError,
  SandboxImageUnavailableError,
} from "../src/sandbox-images";
import { sandboxFactory as localSubprocessFactory } from "../src/adapters/local-subprocess";

describe("SANDBOX_IMAGES catalog", () => {
  it("treats unset and blank as an empty catalog", () => {
    expect(parseSandboxImageCatalog(undefined)).toBe(EMPTY_SANDBOX_IMAGE_CATALOG);
    expect(parseSandboxImageCatalog("  ").list()).toEqual([]);
    expect(parseSandboxImageCatalog("{}").list()).toEqual([]);
  });

  it("parses entries and lists them without the provider reference", () => {
    const catalog = parseSandboxImageCatalog(JSON.stringify({
      analytics: {
        reference: " registry.example/oma/analytics:1 ",
        label: "Analytics",
        description: "pandas + Claude ACP",
      },
      bare: { reference: "tmpl_123" },
    }));
    expect(catalog.has("analytics")).toBe(true);
    expect(catalog.get("analytics")?.reference).toBe("registry.example/oma/analytics:1");
    expect(catalog.list()).toEqual([
      { alias: "analytics", label: "Analytics", description: "pandas + Claude ACP" },
      { alias: "bare", label: "bare", description: null },
    ]);
    expect(JSON.stringify(catalog.list())).not.toContain("registry.example");
  });

  it.each([
    ["not json", "SANDBOX_IMAGES must be valid JSON"],
    ["[]", "must be a JSON object"],
    ['"x"', "must be a JSON object"],
    ['{"Bad Alias":{"reference":"x"}}', 'alias "Bad Alias"'],
    ['{"a":"img:1"}', 'SANDBOX_IMAGES["a"] must be an object'],
    ['{"a":{}}', "reference must be a non-empty string"],
    ['{"a":{"reference":"  "}}', "reference must be a non-empty string"],
    ['{"a":{"reference":"x","label":1}}', "label must be a string"],
    ['{"a":{"reference":"x","description":false}}', "description must be a string"],
    ['{"a":{"reference":"x","image":"y"}}', 'unknown key "image"'],
  ])("rejects %s", (raw, message) => {
    expect(() => parseSandboxImageCatalog(raw)).toThrow(SandboxImageCatalogError);
    expect(() => parseSandboxImageCatalog(raw)).toThrow(message);
  });

  it("resolves a selected alias and fails loudly for a removed one", () => {
    const catalog = parseSandboxImageCatalog('{"analytics":{"reference":"img:1"}}');
    expect(resolveSandboxImage(catalog, undefined, "env_1")).toBeUndefined();
    expect(resolveSandboxImage(catalog, "analytics", "env_1")).toEqual({
      alias: "analytics",
      reference: "img:1",
    });
    expect(() => resolveSandboxImage(catalog, "gone", "env_1")).toThrow(SandboxImageUnavailableError);
    expect(() => resolveSandboxImage(catalog, "gone", "env_1")).toThrow(
      /Sandbox image "gone" selected by environment env_1 is not in this deployment's SANDBOX_IMAGES catalog/,
    );
  });

  it("lets adapters without per-session images reject a selection", async () => {
    expect(() => rejectSandboxImageSelection("x", undefined)).not.toThrow();
    expect(() => rejectSandboxImageSelection("sprites", { alias: "a", reference: "r" })).toThrow(
      /SANDBOX_PROVIDER=sprites does not support per-environment sandbox images/,
    );
    await expect(localSubprocessFactory(
      { sessionId: "s", workdir: "/tmp/ei-unused", image: { alias: "a", reference: "r" } },
      {},
    )).rejects.toThrow(/local-subprocess does not support/);
  });
});
