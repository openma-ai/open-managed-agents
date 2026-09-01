import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { SkillsApplicationPort } from "../src/index";
import { skillView, makeSkillsPort } from "./skill-fixtures";
import { buildSkillsTestApi } from "./test-api";
import { withAnthropicFormDataSupport } from "../../../test/anthropic-sdk-fetch";

function makeClient(port: SkillsApplicationPort): Anthropic {
  const api = buildSkillsTestApi(port);
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

describe("Skills API — /v1/skills", () => {
  it("adapts a multi-file skill upload without multipart leakage", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillsPort({
        createSkill: async (command) => {
          calls.push({
            displayTitle: command.displayTitle,
            files: command.files.map((file) => ({
              filename: file.filename,
              mimeType: file.mimeType,
              content: new TextDecoder().decode(file.content),
            })),
          });
          return { type: "created", skill: skillView };
        },
      }),
    );

    const skill = await client.beta.skills.create({
      files: [
        new File(["# Repository guide"], "repository-guide/SKILL.md", {
          type: "text/markdown",
        }),
        new File(["support"], "repository-guide/support.txt", {
          type: "text/plain",
        }),
      ],
      display_title: "Repository guide",
    });

    expect(calls).toEqual([
      {
        displayTitle: "Repository guide",
        files: [
          {
            filename: "repository-guide/SKILL.md",
            mimeType: "text/markdown",
            content: "# Repository guide",
          },
          {
            filename: "repository-guide/support.txt",
            mimeType: "text/plain",
            content: "support",
          },
        ],
      },
    ]);
    expect(skill).toEqual({
      id: "skill_01",
      created_at: "2026-08-26T13:00:00.000Z",
      display_title: "Repository guide",
      latest_version: "1759178010641129",
      source: "custom",
      type: "skill",
      updated_at: "2026-08-26T13:00:00.000Z",
    });
  });

  it("retrieves a skill", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillsPort({
        retrieveSkill: async (query) => {
          calls.push(query);
          return { type: "found", skill: skillView };
        },
      }),
    );

    await client.beta.skills.retrieve("skill_01");

    expect(calls).toEqual([{ skillId: "skill_01" }]);
  });

  it("lists skills using semantic pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillsPort({
        listSkills: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { skills: [skillView], nextCursor: "skill_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.skills.list({
      limit: 10,
      page: "skill_page_01",
      source: "custom",
    });

    expect(calls).toEqual([
      { pageSize: 10, cursor: "skill_page_01", source: "custom" },
    ]);
    expect(page.data[0]?.id).toBe("skill_01");
    expect(page.next_page).toBe("skill_page_02");
  });

  it("deletes a skill with the official tombstone", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeSkillsPort({
        deleteSkill: async (command) => {
          calls.push(command);
          return { type: "deleted", skillId: "skill_01" };
        },
      }),
    );

    const deleted = await client.beta.skills.delete("skill_01");

    expect(calls).toEqual([{ skillId: "skill_01" }]);
    expect(deleted).toEqual({ id: "skill_01", type: "skill_deleted" });
  });
});
