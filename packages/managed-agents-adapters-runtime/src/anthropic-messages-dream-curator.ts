import type {
  CurateDream,
  CuratedDream,
  DreamCuratorPort,
  DreamMemoryDocument,
} from "@open-managed-agents/managed-agents-application";

export interface AnthropicMessagesDreamCuratorDependencies {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const SYSTEM =
  "Curate an agent memory store. Merge duplicates, remove stale entries, " +
  "and preserve durable decisions. Return only JSON in the shape " +
  '{"memories":[{"path":"/topic.md","content":"..."}]}. ' +
  "Every path must start with /.";

export class AnthropicMessagesDreamCurator implements DreamCuratorPort {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly dependencies: AnthropicMessagesDreamCuratorDependencies,
  ) {
    if (dependencies.apiKey.length === 0) {
      throw new Error("Anthropic API key is required for Dream curation");
    }
    this.baseUrl = (dependencies.baseUrl ?? "https://api.anthropic.com")
      .replace(/\/+$/u, "");
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
  }

  async curate(input: CurateDream): Promise<CuratedDream> {
    const response = await this.fetcher(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.dependencies.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model.modelId,
        max_tokens: 8192,
        system: SYSTEM,
        messages: [{ role: "user", content: this.prompt(input) }],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Anthropic Dream curator returned ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    const body = await response.json() as MessagesResponse;
    const text = (body.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    const memories = this.parseMemories(text);
    return {
      memories,
      usage: {
        cacheCreationInputTokens: this.token(
          body.usage?.cache_creation_input_tokens,
        ),
        cacheReadInputTokens: this.token(body.usage?.cache_read_input_tokens),
        inputTokens: this.token(body.usage?.input_tokens),
        outputTokens: this.token(body.usage?.output_tokens),
      },
    };
  }

  private prompt(input: CurateDream): string {
    const memories = input.inputMemories.length === 0
      ? "(empty)"
      : input.inputMemories
          .map((memory) => `### ${memory.path}\n${memory.content}`)
          .join("\n\n");
    const sessions = input.inputSessions.length === 0
      ? "(none)"
      : input.inputSessions
          .map((session) =>
            session.title === null
              ? session.id
              : `${session.id} — ${session.title}`
          )
          .join("\n");
    return [
      "# Input memories",
      memories,
      "# Input sessions",
      sessions,
      "# Instructions",
      input.instructions ?? "(none)",
    ].join("\n\n");
  }

  private parseMemories(text: string): DreamMemoryDocument[] {
    const normalized = text.trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/```\s*$/u, "");
    let value: unknown;
    try {
      value = JSON.parse(normalized);
    } catch {
      throw new Error("Anthropic Dream curator returned invalid JSON");
    }
    const candidates = value !== null && typeof value === "object" &&
        "memories" in value
      ? (value as { memories?: unknown }).memories
      : undefined;
    if (!Array.isArray(candidates)) {
      throw new Error("Anthropic Dream curator returned no memories array");
    }
    const memories: DreamMemoryDocument[] = [];
    for (const candidate of candidates) {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        !("path" in candidate) ||
        !("content" in candidate) ||
        typeof candidate.path !== "string" ||
        typeof candidate.content !== "string" ||
        !candidate.path.startsWith("/")
      ) {
        throw new Error("Anthropic Dream curator returned an invalid memory");
      }
      memories.push({ path: candidate.path, content: candidate.content });
    }
    return memories;
  }

  private token(value: number | undefined): number {
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  }
}
