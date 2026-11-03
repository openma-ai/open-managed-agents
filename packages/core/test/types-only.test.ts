import { describe, expect, it } from "vitest";

import manifest from "../package.json";

const sources = import.meta.glob("../src/**/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

// @openma/core is the semver-major contract of ADR 0015: declarations only,
// so publishing it can never ship behaviour or pull a runtime dependency.
describe("@openma/core is types-only", () => {
  it("declares no runtime dependencies", () => {
    const fields = manifest as Record<string, unknown>;
    expect(fields.dependencies).toBeUndefined();
    expect(fields.peerDependencies).toBeUndefined();
    expect(fields.optionalDependencies).toBeUndefined();
  });

  it("exports and imports types only", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    for (const [file, source] of Object.entries(sources)) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const statements = code.split("\n").filter((line) => /^(export|import)\b/.test(line));
      for (const statement of statements) {
        expect(
          /^export (type |interface |declare )|^export type \*|^import type /.test(statement),
          `${file}: ${statement}`,
        ).toBe(true);
      }
      expect(code, file).not.toMatch(/^(?:const|let|var|function|class|enum)\b/m);
      expect(code, file).not.toMatch(/\bimport\(/);
    }
  });

  it("imports nothing outside the package", () => {
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        expect(match[1]!.startsWith("."), `${file} imports ${match[1]}`).toBe(true);
      }
    }
  });
});
