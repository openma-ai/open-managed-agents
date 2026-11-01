/** Token usage shapes used by session list_cost metering at hosted inference egress. */
export interface InferenceTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function finite(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

/** Map OpenAI / Anthropic / Gemini JSON usage objects into TokenUsage. */
export function inferenceUsageFromJson(body: unknown): InferenceTokenUsage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const usage = (root.usage && typeof root.usage === "object"
    ? root.usage
    : root) as Record<string, unknown>;

  // OpenAI chat/completions + responses
  const openaiIn = finite(usage.prompt_tokens) ?? finite(usage.input_tokens);
  const openaiOut = finite(usage.completion_tokens) ?? finite(usage.output_tokens);
  const openaiCache = finite(
    (usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens,
  );

  // Anthropic messages
  const antIn = finite(usage.input_tokens);
  const antOut = finite(usage.output_tokens);
  const antCacheRead = finite(usage.cache_read_input_tokens);
  const antCacheWrite = finite(usage.cache_creation_input_tokens);

  // Gemini generateContent
  const meta = root.usageMetadata as Record<string, unknown> | undefined;
  const gemIn = finite(meta?.promptTokenCount);
  const gemOut = finite(meta?.candidatesTokenCount);

  const input_tokens = openaiIn ?? antIn ?? gemIn;
  const output_tokens = openaiOut ?? antOut ?? gemOut;
  if (input_tokens === undefined && output_tokens === undefined) return null;

  return {
    ...(input_tokens !== undefined ? { input_tokens } : {}),
    ...(output_tokens !== undefined ? { output_tokens } : {}),
    ...(openaiCache !== undefined
      ? { cache_read_input_tokens: openaiCache }
      : antCacheRead !== undefined
        ? { cache_read_input_tokens: antCacheRead }
        : {}),
    ...(antCacheWrite !== undefined ? { cache_creation_input_tokens: antCacheWrite } : {}),
  };
}

/** Pull the last JSON object that looks like usage from an SSE body. */
export function inferenceUsageFromSse(text: string): InferenceTokenUsage | null {
  let found: InferenceTokenUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const usage = inferenceUsageFromJson(parsed);
      if (usage) found = usage;
      // Anthropic streaming: message_start / message_delta carry usage
      if (parsed && typeof parsed === "object") {
        const ev = parsed as { type?: string; message?: { usage?: unknown }; usage?: unknown };
        if (ev.message?.usage) {
          const u = inferenceUsageFromJson({ usage: ev.message.usage });
          if (u) found = { ...found, ...u };
        }
        if (ev.type === "message_delta" && ev.usage) {
          const u = inferenceUsageFromJson({ usage: ev.usage });
          if (u) found = { ...found, ...u };
        }
      }
    } catch {
      // ignore malformed SSE chunks
    }
  }
  return found;
}

/**
 * Tee an upstream inference Response so the caller still gets the body while
 * we asynchronously extract TokenUsage for list_cost metering.
 */
export function observeInferenceResponseUsage(
  response: Response,
  onUsage: (usage: InferenceTokenUsage) => void | Promise<void>,
): Response {
  if (!response.body) {
    void response
      .clone()
      .text()
      .then((text) => {
        try {
          const usage = inferenceUsageFromJson(JSON.parse(text));
          if (usage) return onUsage(usage);
        } catch {
          const usage = inferenceUsageFromSse(text);
          if (usage) return onUsage(usage);
        }
      })
      .catch(() => undefined);
    return response;
  }

  const [forClient, forMeter] = response.body.tee();
  void new Response(forMeter, response)
    .text()
    .then((text) => {
      const ct = response.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream") || text.includes("data:")) {
        const usage = inferenceUsageFromSse(text);
        if (usage) return onUsage(usage);
        return;
      }
      try {
        const usage = inferenceUsageFromJson(JSON.parse(text));
        if (usage) return onUsage(usage);
      } catch {
        const usage = inferenceUsageFromSse(text);
        if (usage) return onUsage(usage);
      }
    })
    .catch(() => undefined);

  return new Response(forClient, response);
}

/** Hooks the hosted inference gateway uses to talk to SessionBudgetGate. */
export interface HostedInferenceBudgetHooks {
  /** false → refuse the upstream call (budget exhausted). */
  allowRequest(): boolean | Promise<boolean>;
  recordUsage(usage: InferenceTokenUsage): void | Promise<void>;
}

/**
 * Run a hosted inference send under session list_cost budget hooks.
 * Inactive budget → hooks null → passthrough.
 */
export async function withHostedInferenceBudget(
  hooks: HostedInferenceBudgetHooks | null | undefined,
  send: () => Promise<Response>,
  exhaustedResponse: () => Response = () =>
    Response.json({ error: "budget_reached" }, { status: 402 }),
): Promise<Response> {
  if (!hooks) return send();
  if (!(await hooks.allowRequest())) return exhaustedResponse();
  const response = await send();
  return observeInferenceResponseUsage(response, (usage) => hooks.recordUsage(usage));
}
