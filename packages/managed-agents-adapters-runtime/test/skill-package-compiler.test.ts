import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ZipSkillPackageCompiler } from "../src";

const markdown = `---
name: repository-guide
description: How to work in this repository
---
# Repository guide
`;

describe("ZipSkillPackageCompiler", () => {
  it("compiles a safe multi-file package and extracts its manifest", async () => {
    const compiler = new ZipSkillPackageCompiler();

    const result = await compiler.compile({
      files: [
        {
          filename: "repository-guide/SKILL.md",
          mimeType: "text/markdown",
          content: new TextEncoder().encode(markdown),
        },
        {
          filename: "repository-guide/reference.txt",
          mimeType: "text/plain",
          content: new TextEncoder().encode("reference"),
        },
      ],
    });

    expect(result.type).toBe("compiled");
    if (result.type !== "compiled") throw new Error(result.message);
    expect(result.package).toMatchObject({
      description: "How to work in this repository",
      directory: "repository-guide",
      name: "repository-guide",
      archive: {
        filename: "repository-guide.zip",
        mediaType: "application/zip",
      },
    });
    const entries = unzipSync(result.package.archive.content);
    expect(Object.keys(entries).sort()).toEqual([
      "repository-guide/SKILL.md",
      "repository-guide/reference.txt",
    ]);
    expect(new TextDecoder().decode(entries["repository-guide/SKILL.md"])).toBe(
      markdown,
    );
  });

  it("roots a flat upload under the manifest name", async () => {
    const compiler = new ZipSkillPackageCompiler();
    const result = await compiler.compile({
      files: [
        {
          filename: "SKILL.md",
          mimeType: "text/markdown",
          content: new TextEncoder().encode(markdown),
        },
      ],
    });

    expect(result.type).toBe("compiled");
    if (result.type !== "compiled") throw new Error(result.message);
    expect(Object.keys(unzipSync(result.package.archive.content))).toEqual([
      "repository-guide/SKILL.md",
    ]);
  });

  it.each([
    {
      name: "path traversal",
      files: [{ filename: "../SKILL.md", content: markdown }],
      message: "Skill file paths must not contain traversal segments",
    },
    {
      name: "duplicate path",
      files: [
        { filename: "repository-guide/SKILL.md", content: markdown },
        { filename: "repository-guide/SKILL.md", content: markdown },
      ],
      message: "Skill file paths must be unique",
    },
    {
      name: "missing manifest",
      files: [{ filename: "repository-guide/readme.md", content: "readme" }],
      message: "Skill package must contain exactly one SKILL.md",
    },
    {
      name: "multiple roots",
      files: [
        { filename: "one/SKILL.md", content: markdown },
        { filename: "two/reference.txt", content: "reference" },
      ],
      message: "Skill files must share one top-level directory",
    },
  ])("rejects $name", async ({ files, message }) => {
    const result = await new ZipSkillPackageCompiler().compile({
      files: files.map((file) => ({
        filename: file.filename,
        mimeType: "text/plain",
        content: new TextEncoder().encode(file.content),
      })),
    });

    expect(result).toEqual({ type: "invalid_request", message });
  });

  it("requires name and description frontmatter", async () => {
    const result = await new ZipSkillPackageCompiler().compile({
      files: [
        {
          filename: "SKILL.md",
          mimeType: "text/markdown",
          content: new TextEncoder().encode("# No frontmatter"),
        },
      ],
    });

    expect(result).toEqual({
      type: "invalid_request",
      message: "SKILL.md must declare name and description frontmatter",
    });
  });
});
