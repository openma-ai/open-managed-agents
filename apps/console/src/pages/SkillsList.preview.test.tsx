import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { SkillsList } from "./SkillsList";

const state = vi.hoisted(() => ({
  fetchPaths: [] as string[],
  download: vi.fn(),
}));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [
      {
        type: "skill",
        id: "skill_review",
        display_title: "code-review",
        source: "custom",
        latest_version: "1001",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    error: null,
  }),
}));

vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => ({
    skills: {
      versions: {
        retrieve: async () => ({ name: "code-review", description: "Review code" }),
        list: async () => ({ data: [] }),
        download: state.download,
      },
    },
  }),
}));

// Zip with code-review/SKILL.md = "# Code review skill", built in Node.
const SKILL_ZIP =
  "UEsDBBQAAAAIAABAIVwJbrsEFQAAABMAAAAUAAAAY29kZS1yZXZpZXcvU0tJTEwubWRTVnDOT0lVKEoty0wtVyjOzszJAQBQSwECFAAUAAAACAAAQCFcCW67BBUAAAATAAAAFAAAAAAAAAAAAAAAAAAAAAAAY29kZS1yZXZpZXcvU0tJTEwubWRQSwUGAAAAAAEAAQBCAAAARwAAAAAA";

beforeEach(() => {
  state.fetchPaths = [];
  state.download.mockReset();
  state.download.mockImplementation(
    async () =>
      new Response(
        Uint8Array.from(atob(SKILL_ZIP), (char) => char.charCodeAt(0)),
        { headers: { "content-type": "application/zip" } },
      ),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      state.fetchPaths.push(String(input));
      return Response.json({ data: [] });
    }),
  );
});

describe("SkillsList version preview", () => {
  it("previews files from the managed /v1 skill version archive", async () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <SkillsList />
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findByText("skill_review");
    const row = screen.getByTestId("data-body-table").querySelector("tbody tr");
    if (!row) throw new Error("Expected a skill row");
    fireEvent.click(row);

    expect(await screen.findByText("code-review/SKILL.md")).toBeInTheDocument();
    expect(screen.getByText("# Code review skill")).toBeInTheDocument();
    expect(state.download).toHaveBeenCalledWith("1001", { skill_id: "skill_review" });
    expect(state.fetchPaths.some((path) => path.includes("/v1/oma/skills/"))).toBe(false);
  });
});
