import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_INTRINSICS = new Set([
  "button",
  "input",
  "label",
  "select",
  "textarea",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
]);

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      return path.includes(`${join("components", "ui")}`) ? [] : sourceFiles(path);
    }
    return extname(path) === ".tsx" && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

function nativeInteractiveElements(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
  const violations: string[] = [];

  for (const match of withoutComments.matchAll(
    /<(button|input|label|select|textarea|table|thead|tbody|tfoot|tr|th|td|caption)\b/g,
  )) {
    const tag = match[1];
    if (!FORBIDDEN_INTRINSICS.has(tag)) continue;
    const line = withoutComments.slice(0, match.index).split("\n").length;
    violations.push(`${relative(SRC_ROOT, path)}:${line} <${tag}>`);
  }
  for (const match of withoutComments.matchAll(
    /<Input\b(?:(?!\/>)[\s\S])*?type="(checkbox|radio)"(?:(?!\/>)[\s\S])*?\/>/g,
  )) {
    const line = withoutComments.slice(0, match.index).split("\n").length;
    violations.push(
      `${relative(SRC_ROOT, path)}:${line} <Input type="${match[1]}">`,
    );
  }
  return violations;
}

describe("mature component boundary", () => {
  it("keeps native interactive elements inside components/ui", () => {
    const violations = sourceFiles(SRC_ROOT).flatMap(nativeInteractiveElements);

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
