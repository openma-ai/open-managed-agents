import type { Client } from "../client.js";

const DREAMS_BETA_HEADER = "managed-agents-2026-04-01,dreaming-2026-04-21";

export type DreamStatus = "pending" | "running" | "completed" | "failed" | "canceled";
export type DreamModel = "claude-opus-4-7" | "claude-sonnet-4-6";

export type DreamInput =
  | { type: "memory_store"; memory_store_id: string }
  | { type: "sessions"; session_ids: string[] };

export type DreamOutput = { type: "memory_store"; memory_store_id: string };

export interface DreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface DreamError {
  type: string;
  message: string;
}

export interface Dream {
  type: "dream";
  id: string;
  status: DreamStatus;
  inputs: DreamInput[];
  outputs: DreamOutput[];
  model: { id: DreamModel };
  instructions: string | null;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
  usage: DreamUsage;
  error: DreamError | null;
}

export interface CreateDreamInput {
  inputs: DreamInput[];
  model: DreamModel;
  instructions?: string | null;
}

export interface ListDreamsOptions {
  include_archived?: boolean;
  limit?: number;
  page?: string;
}

export interface ListDreamsResponse {
  data: Dream[];
  has_more: boolean;
  next_page: string | null;
}

export class DreamsResource {
  constructor(private readonly client: Client) {}

  async create(input: CreateDreamInput): Promise<Dream> {
    return this.request<Dream>("POST", "/v1/dreams", { body: input });
  }

  async list(opts: ListDreamsOptions = {}): Promise<ListDreamsResponse> {
    return this.request<ListDreamsResponse>("GET", "/v1/dreams", {
      query: opts as Record<string, string | number | boolean | undefined>,
    });
  }

  async retrieve(dreamId: string): Promise<Dream> {
    return this.request<Dream>("GET", `/v1/dreams/${dreamId}`);
  }

  async cancel(dreamId: string): Promise<Dream> {
    return this.request<Dream>("POST", `/v1/dreams/${dreamId}/cancel`);
  }

  async archive(dreamId: string): Promise<Dream> {
    return this.request<Dream>("POST", `/v1/dreams/${dreamId}/archive`);
  }

  private async request<T>(
    method: string,
    path: string,
    init?: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
    },
  ): Promise<T> {
    return this.client.request<T>(method, path, {
      ...init,
      headers: { "anthropic-beta": DREAMS_BETA_HEADER },
    });
  }
}
