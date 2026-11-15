import { WorkVerifierExitUnconfirmedError } from "./node-work-verifier.js";
import { randomUUID } from "node:crypto";
import { createSessionOutcomes, createVerifierOutcomeEvaluator, type SessionOutcome, type SessionOutcomeUsage } from "@open-managed-agents/session-outcomes";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/harness-inference-adapters";
import type { ManagedAcpExecutionChannels } from "@open-managed-agents/shared/acp-execution-channels-rpc";
import type { WorkTurnCompletion } from "./work-control-runtime.js";
import type { ManagedRuntimeEventWire } from "@openma/common/managed-runtime";

export type WorkOutcomePublisher = (events: ManagedRuntimeEventWire[]) => Promise<void>;

/** Product-only adapter: shared outcome loop/verifier, existing authenticated
 * history/files and metered model gateway. No provider secrets or second loop. */
export function createWorkOutcomeCompletion(options: {
  sessionId: string;
  apiBaseUrl: string;
  sessionsToken: string;
  channels(): ManagedAcpExecutionChannels | undefined;
  fetch?: typeof globalThis.fetch;
  runExec?: import("./node-work-verifier.js").WorkVerifierExec;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (turn: WorkTurnCompletion & { publishOutcomeEvents(events: ManagedRuntimeEventWire[]): Promise<void> }) => {
    const definition = turn.command.input?.outcome;
    if (!definition) return;
    if (typeof turn.publishOutcomeEvents !== "function") throw new Error("Outcome canonical publication capability unavailable");
    const rubric = normalizeRubric(definition.rubric);
    const rawVerifier = object(turn.command.input?.event).verifier;
    const verifier = rawVerifier && typeof rawVerifier.type === "string" ? rawVerifier as SessionOutcome["verifier"] : undefined;
    const outcome: SessionOutcome = { verifier, outcomeId: definition.id, description: definition.description, rubric, maxIterations: definition.maxIterations };
    let history: unknown[] = [], lastStart: string | undefined;
    let active: SessionOutcome | null = outcome;
    let lastVerdict: string | undefined;
    let historyIncomplete = false;
    let unconfirmedActivity: WorkVerifierExitUnconfirmedError | undefined;
    const read = async (path: string) => {
      turn.signal.throwIfAborted();
      const response = await fetcher(new URL(path, options.apiBaseUrl), { signal: turn.signal, redirect: "error", headers: { authorization: `Bearer ${options.sessionsToken}` } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Outcome source HTTP ${response.status}`); }
      return response;
    };
    const refresh = async () => {
      await turn.flush(); history = []; historyIncomplete=false; let bytes=0; let page: string | null = null; const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ order: "asc", limit: "100", ...(page ? { page } : {}) });
        const result = await (await read(`/v1/sessions/${encodeURIComponent(options.sessionId)}/events?${query}`)).json() as { data?: unknown[]; next_page?: string | null };
        if (!Array.isArray(result.data) || !(result.next_page === null || typeof result.next_page === "string")) throw new Error("Invalid outcome history page");
        bytes += JSON.stringify(result.data).length;
        if(bytes > 200_000 || history.length + result.data.length > 1000) {historyIncomplete=true;break;}
        history.push(...result.data); page = result.next_page;
        if (page !== null) { if (seen.has(page)) throw new Error("Repeated outcome history cursor"); seen.add(page); }
      } while (page !== null);
    };
    const publish = async (event: Record<string, unknown>) => {
      const id = `sevt_${randomUUID()}`, at = new Date().toISOString();
      await turn.publishOutcomeEvents([{ ...event, id, processed_at: at } as ManagedRuntimeEventWire]);
      return { id, at };
    };
    const evaluator = createVerifierOutcomeEvaluator<unknown[]>({
      judge: () => (prompt, signal) => judgeThroughGateway(options.channels(), options.sessionId, prompt, signal ?? turn.signal, fetcher),
      files: { read: async ({ fileId }) => {
        try { return { type: "found", text: await (await read(`/v1/files/${encodeURIComponent(fileId)}/content`)).text() }; }
        catch { turn.signal.throwIfAborted(); return { type: "unavailable", reason: "scoped rubric file unavailable" }; }
      } },
      verifierContext: () => ({ sessionId: options.sessionId, runExec: async (command, settings) => {
        if (!options.runExec) throw new Error("Trusted Work verifier execution capability unavailable");
        try { return await options.runExec(command, settings, turn.signal); }
        catch(error) { if(error instanceof WorkVerifierExitUnconfirmedError)unconfirmedActivity=error; throw error; }
      } }),
      history: snapshot => snapshot ?? [],
    });
    // Prepare inside the iteration just as main's Node adapter does: malformed
    // rubric still gets linked start/ongoing/end spans, not an unlinked verdict.
    const loop = createSessionOutcomes<unknown[]>({
      evaluator: { prepare: async ({ outcome }) => ({ type: "ready", outcome, evaluator: {
        evaluate: async ({ iteration, abortSignal }) => {
          if(historyIncomplete)return {result:"failed",explanation:"Canonical outcome history truncated; evaluation cannot establish success"};
          if (!outcome.verifier && !options.channels()?.hostedInference.model.wireModel) return { result: "failed", explanation: "Outcome execution channels/model capability unavailable" };
          const prepared = await evaluator.prepare({ outcome: active ?? outcome, abortSignal });
          if (prepared.type === "failed") return { result: "failed", explanation: prepared.explanation };
          active = prepared.outcome;
          try {
            const evaluation = await prepared.evaluator.evaluate({ iteration, abortSignal, snapshot: history });
            if(unconfirmedActivity)throw unconfirmedActivity;
            abortSignal.throwIfAborted(); // ScriptVerifier converts exec errors to scores.
            return evaluation;
          }
          catch (error) {
            // The shared judge only short-circuits AbortError. A gateway
            // authority/budget denial is terminal, not a transient retry or
            // permission to run a native revision. Keep its verdict failed,
            // distinct from genuine user interruption in the shared loop.
            if (error instanceof OutcomeGatewayDenied) return { result: "failed", explanation: error.message };
            throw error;
          }
        },
      } }) },
      events: {
        evaluationStarted: async ({ outcomeId, iteration }) => {
          await refresh();
          const event = await publish({ type: "span.outcome_evaluation_start", outcome_id: outcomeId, iteration });
          lastStart = event.id; return { startEventId: event.id };
        },
        evaluationOngoing: async ({ outcomeId, iteration }) => { await publish({ type: "span.outcome_evaluation_ongoing", outcome_id: outcomeId, iteration }); },
        evaluationEnded: async ({ verdict, started }) => {
          const start = started?.startEventId ?? lastStart;
          if (!start) throw new Error("Outcome evaluation start receipt unavailable");
          const event = await publish({ type: "span.outcome_evaluation_end", outcome_id: verdict.outcomeId, outcome_evaluation_start_id: start,
            iteration: verdict.iteration, result: verdict.result, explanation: verdict.explanation,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...verdict.usage } });
          lastVerdict = `${verdict.iteration}:${verdict.result}`; return event.at;
        },
      },
      // The acknowledged end span updates the server's outcome aggregate.
      // Local state is only the shared loop's rubric cache, never authority.
      progress: { persist: progress => {
        if (progress.verdict && lastVerdict !== `${progress.verdict.iteration}:${progress.verdict.result}`) throw new Error("Outcome progress lacks canonical receipt");
        if (progress.outcome !== undefined) active = progress.outcome;
      } },
      revision: { revise: async ({ iteration, feedback }) => {
        turn.signal.throwIfAborted();
        await turn.runRevision({ turnId: `${turn.command.turnId}:outcome:${iteration}`, text: feedback });
      } },
    });
    await loop.evaluate({ outcome, abortSignal: turn.signal });
    if(unconfirmedActivity)throw unconfirmedActivity;
  };
}
function normalizeRubric(value: unknown): SessionOutcome["rubric"] {
  if (typeof value === "string") return value;
  const v = object(value);
  if (v.type === "text" && typeof v.content === "string") return { type: "text", content: v.content };
  if (v.type === "file" && typeof (v.file_id ?? v.fileId) === "string") return { type: "file", fileId: String(v.file_id ?? v.fileId) };
  return undefined;
}
const object = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
async function judgeThroughGateway(channels: ManagedAcpExecutionChannels | undefined, sessionId: string, prompt: { system: string; user: string }, signal: AbortSignal, fetcher: typeof fetch): Promise<{ text: string; usage: SessionOutcomeUsage }> {
  signal.throwIfAborted();
  const inference = channels?.hostedInference;
  if (!inference?.sessionsToken.startsWith("oma_sbx_") || !inference.model.wireModel) throw new Error("Outcome execution channels/model capability unavailable");
  const endpoints = resolveProtocolEndpointsFromModelCard(inference.model);
  const endpoint = endpoints.find(e => e.protocol === "openai-responses") ?? endpoints.find(e => e.protocol === "anthropic-messages") ?? endpoints[0];
  if (!endpoint) throw new Error("Outcome model protocol unavailable");
  // Only gateway path fragments from authority; never contact upstreamBaseUrl.
  if (!/^[a-zA-Z0-9/_-]+$/.test(endpoint.proxyPathSegment) || endpoint.proxyPathSegment.includes("..")) throw new Error("Invalid outcome model gateway path");
  const base = new URL(inference.gatewayBaseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid outcome gateway");
  const model = inference.model.wireModel;
  let path: string, body: object;
  switch (endpoint.protocol) {
    case "anthropic-messages": path = "/v1/messages"; body = { model, max_tokens: 4096, system: prompt.system, messages: [{ role: "user", content: prompt.user }], stream: false }; break;
    case "openai-responses": path = "/responses"; body = { model, instructions: prompt.system, input: prompt.user, stream: false }; break;
    case "gemini": path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`; body = { systemInstruction: { parts: [{ text: prompt.system }] }, contents: [{ role: "user", parts: [{ text: prompt.user }] }] }; break;
    default: throw new Error("Outcome model protocol unavailable");
  }
  let response: Response;
  try {
    response = await fetcher(new URL(`/v1/oma/inference-proxy/${encodeURIComponent(sessionId)}/${endpoint.proxyPathSegment}${path}`, base), {
      method: "POST", signal, redirect: "error", headers: { authorization: `Bearer ${inference.sessionsToken}`, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body),
    });
  } catch { if (signal.aborted) throw new DOMException("Outcome evaluation interrupted", "AbortError"); throw new Error("Outcome model transport unavailable"); }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 402, 403].includes(response.status)) throw new OutcomeGatewayDenied(response.status);
    throw new Error(`Outcome model HTTP ${response.status}`);
  }
  const result = object(await response.json()); // gateway EOF awaits durable usage
  const u = object(result.usage ?? result.usageMetadata);
  const input = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount;
  const output = u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount;
  if (!Number.isFinite(input) || !Number.isFinite(output)) throw new Error("Outcome model usage unavailable");
  const text = endpoint.protocol === "openai-responses" ? result.output?.flatMap((item: any) => item.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("")
    : endpoint.protocol === "anthropic-messages" ? result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
    : result.candidates?.[0]?.content?.parts?.map((c: any) => c.text ?? "").join("");
  if (typeof text !== "string") throw new Error("Outcome model text unavailable");
  return { text, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: u.cache_read_input_tokens ?? object(u.prompt_tokens_details).cached_tokens ?? u.cachedContentTokenCount ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 } };
}

class OutcomeGatewayDenied extends Error {
  override readonly name = "AbortError";
  constructor(status: number) { super(status === 402 ? "Outcome model budget reached" : "Outcome model authority rejected"); }
}
