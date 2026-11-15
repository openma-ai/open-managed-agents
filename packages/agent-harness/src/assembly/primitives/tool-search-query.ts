export interface ParsedToolSearchQuery {
  /** `select:a,b` explicit tool names (case-sensitive match). */
  selected: string[];
  /** Tokens that must all appear in the searchable text. */
  required: string[];
  /** Free-text terms (BM25). */
  terms: string[];
}

const SELECT_PREFIX = /^select:\s*/i;

export function parseToolSearchQuery(raw: string): ParsedToolSearchQuery {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { selected: [], required: [], terms: [] };
  }

  if (SELECT_PREFIX.test(trimmed)) {
    const names = trimmed.replace(SELECT_PREFIX, "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return { selected: names, required: [], terms: [] };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const required: string[] = [];
  const terms: string[] = [];
  for (const part of parts) {
    if (part.startsWith("+") && part.length > 1) required.push(part.slice(1).toLowerCase());
    else terms.push(part.toLowerCase());
  }

  return { selected: [], required, terms };
}

export function matchesRequiredTerms(haystack: string, required: string[]): boolean {
  if (required.length === 0) return true;
  const lower = haystack.toLowerCase();
  return required.every((term) => lower.includes(term));
}

/**
 * When the query is a single free-text token, treat it as an MCP server filter
 * only if it matches a known server name from the catalog.
 */
export function resolveServerNameFilter(
  parsed: ParsedToolSearchQuery,
  knownServerNames: ReadonlySet<string>,
): string | undefined {
  if (parsed.selected.length > 0 || parsed.required.length > 0) return undefined;
  if (parsed.terms.length !== 1) return undefined;
  const token = parsed.terms[0];
  return knownServerNames.has(token) ? token : undefined;
}
