import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type {
  SkillVersionsApplicationPort,
  SkillsApplicationPort,
} from "../src/index";
import {
  makeSkillVersionsPort,
  makeSkillsPort,
  skillVersionView,
} from "./skill-fixtures";
import { buildSkillsTestApi } from "./test-api";
import { withAnthropicFormDataSupport } from "../../../test/anthropic-sdk-fetch";

function makeClient(
  versions: SkillVersionsApplicationPort,
  skills: SkillsApplicationPort = makeSkillsPort({}),
): Anthropic {
  const api = buildSkillsTestApi(skills, versions);
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: withAnthropicFormDataSupport(async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    }),
  });
}

describe("Skills API — /v1/skills/:skill_id/versions", () => {
  it("creates a version from transport-free file inputs", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillVersionsPort({
        createSkillVersion: async (command) => {
          calls.push({
            skillId: command.skillId,
            files: command.files.map((file) => ({
              filename: file.filename,
              content: new TextDecoder().decode(file.content),
            })),
          });
          return { type: "created", version: skillVersionView };
        },
      }),
    );

    const version = await client.beta.skills.versions.create("skill_01", {
      files: [
        new File(["# Version 2"], "repository-guide/SKILL.md", {
          type: "text/markdown",
        }),
      ],
    });

    expect(calls).toEqual([
      {
        skillId: "skill_01",
        files: [
          {
            filename: "repository-guide/SKILL.md",
            content: "# Version 2",
          },
        ],
      },
    ]);
    expect(version).toMatchObject({
      id: "skv_01",
      skill_id: "skill_01",
      type: "skill_version",
      version: "1759178010641129",
    });
  });

  it("retrieves a version using both identifiers", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillVersionsPort({
        retrieveSkillVersion: async (query) => {
          calls.push(query);
          return { type: "found", version: skillVersionView };
        },
      }),
    );

    await client.beta.skills.versions.retrieve("1759178010641129", {
      skill_id: "skill_01",
    });

    expect(calls).toEqual([
      { skillId: "skill_01", version: "1759178010641129" },
    ]);
  });

  it("lists versions using semantic pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillVersionsPort({
        listSkillVersions: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: {
              versions: [skillVersionView],
              nextCursor: "version_page_02",
            },
          };
        },
      }),
    );

    const page = await client.beta.skills.versions.list("skill_01", {
      limit: 10,
      page: "version_page_01",
    });

    expect(calls).toEqual([
      { skillId: "skill_01", pageSize: 10, cursor: "version_page_01" },
    ]);
    expect(page.data[0]?.version).toBe("1759178010641129");
    expect(page.next_page).toBe("version_page_02");
  });

  it("downloads version bytes without exposing Response to the port", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillVersionsPort({
        downloadSkillVersion: async (query) => {
          calls.push(query);
          return {
            type: "found",
            file: {
              content: new TextEncoder().encode("zip-content"),
              mimeType: "application/zip",
              filename: "repository-guide.zip",
            },
          };
        },
      }),
    );

    const response = await client.beta.skills.versions.download(
      "1759178010641129",
      { skill_id: "skill_01" },
    );

    expect(calls).toEqual([
      { skillId: "skill_01", version: "1759178010641129" },
    ]);
    expect(
      new TextDecoder().decode(await response.arrayBuffer()),
    ).toBe("zip-content");
  });

  it("deletes a version with the official tombstone", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillVersionsPort({
        deleteSkillVersion: async (command) => {
          calls.push(command);
          return { type: "deleted", version: "1759178010641129" };
        },
      }),
    );

    const deleted = await client.beta.skills.versions.delete(
      "1759178010641129",
      { skill_id: "skill_01" },
    );

    expect(calls).toEqual([
      { skillId: "skill_01", version: "1759178010641129" },
    ]);
    expect(deleted).toEqual({
      id: "1759178010641129",
      type: "skill_version_deleted",
    });
  });

  it("maps concurrent version creation to a conflict", async () => {
    const client = makeClient(
      makeSkillVersionsPort({
        createSkillVersion: async () => ({
          type: "version_conflict",
          message: "Skill changed concurrently",
        }),
      }),
    );

    await expect(
      client.beta.skills.versions.create("skill_01", {
        files: [new File(["# Version 2"], "repository-guide/SKILL.md")],
      }),
    ).rejects.toMatchObject({
      status: 409,
      type: "conflict_error",
      error: {
        error: {
          type: "conflict_error",
          message: "Skill changed concurrently",
        },
      },
    });
  });

  it("maps concurrent version deletion to a conflict", async () => {
    const client = makeClient(
      makeSkillVersionsPort({
        deleteSkillVersion: async () => ({
          type: "version_conflict",
          message: "Skill changed concurrently",
        }),
      }),
    );

    await expect(
      client.beta.skills.versions.delete("1759178010641129", {
        skill_id: "skill_01",
      }),
    ).rejects.toMatchObject({
      status: 409,
      type: "conflict_error",
      error: {
        error: {
          type: "conflict_error",
          message: "Skill changed concurrently",
        },
      },
    });
  });
});
