import { describe, expect, it } from "vitest";
import { createBm25Index, tokenizeForSearch } from "../src/harness/assembly/primitives/bm25";
import { createToolCatalogSearch } from "../src/harness/assembly/components/tool-catalog-search";
import { parseToolSearchQuery } from "../src/harness/assembly/primitives/tool-search-query";
import type { ToolCatalogEntry } from "../src/harness/assembly/types";

const catalog: ToolCatalogEntry[] = [
  { name: "read_file", description: "Read a file from disk", serverName: "builtin" },
  { name: "mcp__github__search", description: "Search GitHub repos", serverName: "github" },
  { name: "mcp__github__create_issue", description: "Open a GitHub issue", serverName: "github" },
  { name: "mcp__docs__lookup", description: "Lookup API documentation", serverName: "docs" },
  { name: "mcp__search__find", description: "Generic search helper", serverName: "search" },
];

describe("tool_search query parser", () => {
  it("parses select syntax", () => {
    expect(parseToolSearchQuery("select:read_file,mcp__github__search")).toEqual({
      selected: ["read_file", "mcp__github__search"],
      required: [],
      terms: [],
    });
  });

  it("parses required terms and free text", () => {
    expect(parseToolSearchQuery("github +issue")).toEqual({
      selected: [],
      required: ["issue"],
      terms: ["github"],
    });
  });
});

describe("BM25 tokenizer", () => {
  it("splits mcp tool names and matches issue", () => {
    const tokens = tokenizeForSearch("mcp__github__create_issue");
    expect(tokens).toContain("issue");
    const index = createBm25Index([
      { id: "mcp__github__create_issue", text: "mcp__github__create_issue Open a GitHub issue" },
    ]);
    expect(index.search("issue", 4)).toEqual(["mcp__github__create_issue"]);
  });

  it("splits camelCase before lowercasing", () => {
    expect(tokenizeForSearch("createIssue")).toEqual(expect.arrayContaining(["create", "issue"]));
    expect(tokenizeForSearch("mcp__github__createIssue")).toEqual(
      expect.arrayContaining(["mcp", "github", "create", "issue"]),
    );
    const index = createBm25Index([
      { id: "mcp__github__createIssue", text: "mcp__github__createIssue Open a GitHub issue" },
    ]);
    expect(index.search("issue", 4)).toEqual(["mcp__github__createIssue"]);
  });

  it("indexes CJK with bigrams", () => {
    const index = createBm25Index([{ id: "doc", text: "文档说明" }]);
    expect(index.search("文档", 2)).toEqual(["doc"]);
  });
});

describe("tool catalog search", () => {
  const search = createToolCatalogSearch();

  it("returns explicit selections", () => {
    const result = search.search(catalog, { query: "select:mcp__docs__lookup", limit: 8 });
    expect(result.entries.map((e) => e.name)).toEqual(["mcp__docs__lookup"]);
  });

  it("filters by server name only when the token is a known server", () => {
    const result = search.search(catalog, { query: "github", limit: 8 });
    expect(result.entries.map((e) => e.name)).toEqual([
      "mcp__github__search",
      "mcp__github__create_issue",
    ]);
  });

  it("BM25 single-token queries that are not server names", () => {
    const result = search.search(catalog, { query: "search", limit: 8 });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.some((e) => e.serverName === "search")).toBe(true);
  });

  it("ranks by BM25 and enforces +required terms", () => {
    const result = search.search(catalog, { query: "documentation +lookup", limit: 4 });
    expect(result.entries[0]?.name).toBe("mcp__docs__lookup");
  });
});
