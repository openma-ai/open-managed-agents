// DreamCurator — the LLM-driven memory curation step inside the dream
// pipeline. Pulled out as a port so the runner can be unit-tested with a
// deterministic in-memory curator (test-fakes) while production wires an
// Anthropic-Messages-backed implementation against env.ANTHROPIC_API_KEY.
//
// Why this is a port and not a method on DreamService:
//   - It's I/O-shaped (HTTP call to Anthropic) and we don't want the pure
//     service layer to depend on `fetch`. Same pattern as MemoryStoreService
//     not knowing about R2 directly.
//   - Test-pyramid: route + service tests can wire a synchronous curator
//     and exercise the lifecycle without burning Anthropic tokens.

import type {
  DreamModel,
  DreamUsage,
} from "@open-managed-agents/dreams-store";

/** A single curated memory the LLM emitted. Bounded by the memory store's
 *  per-memory cap (100KB) — we silently truncate over-large entries rather
 *  than reject the whole batch, mirroring how Anthropic's curator handles
 *  hot-loops over a too-large input. */
export interface CuratedMemory {
  path: string;
  content: string;
}

export interface DreamCuratorInput {
  /** Pre-existing memories from the input store, content included. */
  inputMemories: ReadonlyArray<{ path: string; content: string }>;
  /** Surface info on the input sessions. The transcript itself is not always
   *  available to the curator in this implementation; the curator works from
   *  the path/title list + dream-level `instructions`. Future work: stream
   *  event-log via SessionDO RPC. */
  inputSessions: ReadonlyArray<{ id: string; title: string | null }>;
  instructions: string | null;
  model: DreamModel;
}

export interface DreamCuratorOutput {
  memories: CuratedMemory[];
  usage: DreamUsage;
}

export interface DreamCurator {
  curate(input: DreamCuratorInput): Promise<DreamCuratorOutput>;
}

// ============================================================
// Anthropic Messages-backed implementation (production)
// ============================================================

/**
 * Real Anthropic Messages call. Single-shot — no tool use, no streaming.
 * The LLM is prompted to emit a JSON object `{"memories": [{path, content},
 * ...]}`; we parse and validate. Bad JSON → fall back to keeping the
 * input store untouched (dedup-only mode) so the pipeline can still
 * complete rather than blowing up the whole dream.
 *
 * `env.ANTHROPIC_API_KEY` is required at construction; the factory in
 * apps/main/src/dreams/index.ts pulls it off the Worker env. Missing key
 * raises at construction so the route handler returns 500 immediately,
 * not after the dream is already in `running`.
 */
export class AnthropicDreamCurator implements DreamCurator {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.anthropic.com",
  ) {
    if (!apiKey) throw new Error("AnthropicDreamCurator: ANTHROPIC_API_KEY required");
  }

  async curate(input: DreamCuratorInput): Promise<DreamCuratorOutput> {
    const prompt = buildCurationPrompt(input);
    const body = {
      model: input.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: prompt }],
    };
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`anthropic curator HTTP ${res.status}: ${detail.slice(0, 500)}`);
    }
    const json = (await res.json()) as AnthropicMessagesResponse;
    const text = textFromMessagesResponse(json);
    const memories = parseCuratedMemoriesJson(text) ?? dedupOnly(input.inputMemories);
    return {
      memories,
      usage: {
        input_tokens: int(json.usage?.input_tokens),
        output_tokens: int(json.usage?.output_tokens),
        cache_creation_input_tokens: int(json.usage?.cache_creation_input_tokens),
        cache_read_input_tokens: int(json.usage?.cache_read_input_tokens),
      },
    };
  }
}

/** Deterministic curator for tests / offline mode: dedupes by path
 *  (latest wins), drops empty entries. */
export class DedupOnlyDreamCurator implements DreamCurator {
  async curate(input: DreamCuratorInput): Promise<DreamCuratorOutput> {
    return {
      memories: dedupOnly(input.inputMemories),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  }
}

// ============================================================
// Helpers (exported for tests)
// ============================================================

export const SYSTEM_PROMPT =
  "You are curating an agent's memory store. Read the input memories and " +
  "session list, then emit a reorganized memory set: merge duplicates, drop " +
  "stale entries, surface insights from recurring patterns. Output STRICT " +
  "JSON in this exact shape (no prose, no markdown fences):\n" +
  '{"memories": [{"path": "/topic/file.md", "content": "..."}, ...]}\n' +
  "Each memory's content stays under 100KB. Prefer fewer, denser entries. " +
  "Paths start with a forward slash.";

export function buildCurationPrompt(input: DreamCuratorInput): string {
  const memoryBlock = input.inputMemories
    .map((m) => `### ${m.path}\n${m.content}`)
    .join("\n\n");
  const sessionBlock =
    input.inputSessions.length === 0
      ? "(no sessions)"
      : input.inputSessions
          .map((s, i) => `${i + 1}. ${s.id}${s.title ? ` — ${s.title}` : ""}`)
          .join("\n");
  const instructionBlock = input.instructions
    ? `\nAdditional instructions from the caller:\n${input.instructions}\n`
    : "";
  return `# Input memories
${memoryBlock || "(empty store)"}

# Input sessions
${sessionBlock}
${instructionBlock}
Emit the curated JSON now.`;
}

export function parseCuratedMemoriesJson(raw: string): CuratedMemory[] | null {
  // Be permissive — strip leading/trailing fences if the model adds them.
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(trimmed);
    const arr = parsed?.memories;
    if (!Array.isArray(arr)) return null;
    const out: CuratedMemory[] = [];
    for (const entry of arr) {
      if (
        entry &&
        typeof entry.path === "string" &&
        typeof entry.content === "string" &&
        entry.path.length > 0
      ) {
        out.push({ path: entry.path, content: entry.content });
      }
    }
    return out;
  } catch {
    return null;
  }
}

function dedupOnly(
  inputs: ReadonlyArray<{ path: string; content: string }>,
): CuratedMemory[] {
  const byPath = new Map<string, string>();
  for (const m of inputs) byPath.set(m.path, m.content);
  return Array.from(byPath, ([path, content]) => ({ path, content }));
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function textFromMessagesResponse(r: AnthropicMessagesResponse): string {
  return (r.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
