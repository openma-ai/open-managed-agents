/**
 * HTTP transport over the domain model-egress meter.
 * Allow/record always go through SessionBudgetGate via ModelEgress
 * (beginModelEgress / completeModelEgress). This file only parses provider
 * response bodies into TokenUsage.
 */
import type { ModelEgress, TokenUsage } from "@open-managed-agents/domain/sessions";

function finite(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

/** Map OpenAI / Anthropic / Gemini JSON usage objects into domain TokenUsage. */
export function inferenceUsageFromJson(body: unknown): TokenUsage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const usage = (root.usage && typeof root.usage === "object"
    ? root.usage
    : root) as Record<string, unknown>;

  const openaiIn = finite(usage.prompt_tokens) ?? finite(usage.input_tokens);
  const openaiOut = finite(usage.completion_tokens) ?? finite(usage.output_tokens);
  const openaiCache = finite(
    (usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens,
  );

  const antIn = finite(usage.input_tokens);
  const antOut = finite(usage.output_tokens);
  const antCacheRead = finite(usage.cache_read_input_tokens);
  const antCacheWrite = finite(usage.cache_creation_input_tokens);

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
export function inferenceUsageFromSse(text: string): TokenUsage | null {
  let found: TokenUsage | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const usage = inferenceUsageFromJson(parsed);
      if (usage) found = usage;
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
 * we extract TokenUsage for the domain meter.
 */
export function observeInferenceResponseUsage(
  response: Response,
  onUsage: (usage: TokenUsage) => void | Promise<void>,
  durable = false,
): Response {
  if (durable && response.body) return observeDurableUsage(response, onUsage);
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

/**
 * Async-capable handle matching domain ModelEgress. CF uses HTTP; Node uses
 * the in-process `modelEgress(gate)`.
 */
export type HostedInferenceEgress = {
  /** A successful response EOF waits for canonical usage persistence. */
  durable?: boolean;
  begin(): boolean | Promise<boolean>;
  complete(usage: TokenUsage): void | Promise<void>;
};

/**
 * Sandbox inference-proxy egress: same domain meter as Pi (`ModelEgress`).
 * Pass `modelEgress(gate)` or a CF HTTP adapter that calls Session DO
 * begin/complete. Inactive → null → passthrough.
 */
export async function withHostedInferenceBudget(
  egress: HostedInferenceEgress | ModelEgress | null | undefined,
  send: () => Promise<Response>,
  exhaustedResponse: () => Response = () =>
    Response.json({ error: "budget_reached" }, { status: 402 }),
): Promise<Response> {
  if (!egress) return send();
  if (!(await egress.begin())) return exhaustedResponse();
  const response = await send();
  return observeInferenceResponseUsage(response, (usage) => egress.complete(usage), "durable" in egress && egress.durable === true);
}

/** Generic host admission decision for one hosted model request. */
export type HostedInferenceAdmissionDecision =
  | { type: "allowed" }
  | { type: "denied"; status: number; body: unknown };

/**
 * Edge hook: let the host refuse a hosted model request before it is sent.
 * Distinct from `budget_reached` (per-session max_list_cost). The response
 * status and JSON body come verbatim from the host hook. A missing hook
 * (Node / self-host) admits all.
 */
export async function withHostedInferenceAdmission(
  admit: (() => Promise<HostedInferenceAdmissionDecision>) | null | undefined,
  send: () => Promise<Response>,
): Promise<Response> {
  if (admit) {
    const decision = await admit();
    if (decision.type === "denied") {
      return Response.json(decision.body ?? null, { status: decision.status });
    }
  }
  return send();
}

/** Bounded incremental observation. One upstream stream, no detached promise:
 * EOF is committed only after canonical metering. Cancellation never invents
 * completed usage. Unknown/oversized metering frames fail closed. */
function observeDurableUsage(response: Response, onUsage: (usage: TokenUsage) => void | Promise<void>): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  let pending = "";
  let usage: TokenUsage | null = null;
  const observeLine = (line: string) => {
    const next = inferenceUsageFromSse(line);
    if (next) usage = {...usage,...next};
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (!chunk.done) {
          pending += decoder.decode(chunk.value,{stream:true});
          if (sse) {
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              observeLine(pending.slice(0,end));
              pending = pending.slice(end+1);
            }
          }
          if (pending.length > 1_048_576) throw new Error("Model usage frame exceeds meter limit");
          controller.enqueue(chunk.value);
          return;
        }
        pending += decoder.decode();
        if (sse) observeLine(pending);
        else { try { usage = inferenceUsageFromJson(JSON.parse(pending)); } catch { /* rejected below */ } }
        if (response.ok && usage === null) throw new Error("Completed model response has no usage");
        if (usage) await onUsage(usage);
        controller.close();
      } catch (error) { await reader.cancel(error).catch(()=>{}); controller.error(error); }
    },
    cancel: reason => reader.cancel(reason),
  });
  return new Response(body,response);
}
