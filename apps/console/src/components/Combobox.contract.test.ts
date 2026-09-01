import { describe, expect, it } from "vitest";
import { buildComboboxPageUrl, readComboboxNextPage } from "./Combobox";

describe("Combobox Managed Agents contract", () => {
  it("uses page/next_page without sending an unsupported q parameter", () => {
    expect(
      buildComboboxPageUrl("/v1/agents", {
        limit: 20,
        page: "page_2",
        search: "research",
      }),
    ).toBe("/v1/agents?limit=20&page=page_2");

    expect(readComboboxNextPage({ data: [], next_page: "page_3" })).toBe(
      "page_3",
    );
  });

  it("only sends q when a product endpoint opts into it", () => {
    expect(
      buildComboboxPageUrl("/v1/oma/model_cards", {
        limit: 20,
        search: "claude",
        searchParam: "q",
      }),
    ).toBe("/v1/oma/model_cards?limit=20&q=claude");
  });

  it("adapts an explicit product cursor while preserving infinite-feed behavior", () => {
    expect(
      buildComboboxPageUrl("/v1/oma/model_cards", {
        limit: 20,
        page: "cursor_2",
        pagination: "oma",
      }),
    ).toBe("/v1/oma/model_cards?limit=20&cursor=cursor_2");
    expect(
      readComboboxNextPage({ data: [], next_cursor: "cursor_3" }, "oma"),
    ).toBe("cursor_3");
  });
});
