import type { Tool } from "@earendil-works/pi-ai";

/** Serializable assembly state carried in session events (PR2+). */
export interface AssemblyState {
  loadedToolNames: string[];
  loadedSkillIds: string[];
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  serverName?: string;
  parametersText?: string;
}

export interface ToolSearchOptions {
  limit: number;
  query: string;
}

export interface ToolSearchResult {
  entries: ToolCatalogEntry[];
  tools: Tool[];
}

export interface ToolSearchComponent {
  search(catalog: ToolCatalogEntry[], options: ToolSearchOptions): ToolSearchResult;
}
