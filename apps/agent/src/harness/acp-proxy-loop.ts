/**
 * AcpProxyHarness — HarnessInterface implementation that delegates the agent
 * loop to a Claude Code (or other ACP-compatible) child running on a user's
 * registered local runtime.
 *
 * Per-turn flow:
 *   1. Open a WebSocket directly to the RuntimeRoom DO via the cross-script
 *      binding (env.RUNTIME_ROOM). The DO class lives in the main worker but
 *      DOs are namespace-level, so the agent worker binds the same class with
 *      `script_name: "managed-agents"` in wrangler.jsonc — no service-binding
 *      hop through main, no shared INTEGRATIONS_INTERNAL_SECRET. The DO holds
 *      the WS open and shuttles session.* messages to/from the daemon.
 *   2. Send `session.start` (idempotent on the daemon — first time spawns the
 *      ACP child, subsequent times short-circuits to session.ready).
 *   3. Send `session.prompt { text, turn_id }` with the latest user message.
 *   4. Drain `session.event` notifications via AcpTranslator → SessionEvent
 *      broadcast through the runtime.
 *   5. Resolve when `session.complete` arrives, error on `session.error` or
 *      WS close. Honor `runtime.abortSignal` by sending `session.cancel`.
 *
 * Optional ports / no-op surface (Meta-harness fit):
 *   - `onSessionInit`: no-op. System prompt + skills land on the user's
 *     filesystem as AGENTS.md / `.claude/skills/...` via the daemon's bundle
 *     fetch — they don't enter the events stream.
 *   - `shouldCompact` / `compact` / `deriveModelContext`: ACP agents own their
 *     own context; OMA doesn't drive a generateText call here. All return
 *     false / no-op.
 */

import type { HarnessInterface, HarnessContext, HarnessRuntime, HarnessPendingInterruptContext } from "./interface";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { AcpTranslator } from "./acp-translate";
import { generateEventId, log, logError, logWarn } from "@open-managed-agents/shared";

interface AttachedWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: "message" | "close" | "error",
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
  removeEventListener?(event: "message" | "close" | "error", listener: (event: MessageEvent | CloseEvent | Event) => void): void;
}

export class AcpProxyHarness implements HarnessInterface {
  // No platform reminders for ACP path — the spawn-cwd AGENTS.md handles it.
  async onSessionInit(): Promise<void> {
    /* no-op */
  }

  shouldCompact(): boolean {
    return false; // ACP agent manages its own context window
  }

  async compact(): Promise<void> {
    /* no-op */
  }

  deriveModelContext(): never[] {
    return []; // never called — we don't run generateText
  }

  async interruptPending(ctx: HarnessPendingInterruptContext): Promise<string[]> {
    const requests = ctx.pendingActions.flatMap((event) => {
      const value = event as unknown as ParsedFrame;
      const action = record(record(value.input)._openma);
      return value.type === "agent.custom_tool_use" && typeof value.id === "string" && action.type === "runtime_action" && typeof action.turn_id === "string"
        ? [{ id: value.id, turnId: action.turn_id }] : [];
    });
    if (!requests.length) return [];
    const binding = ctx.agent.runtime_binding;
    if (!binding || !ctx.env.RUNTIME_ROOM) throw new Error("Runner interrupt is unavailable");
    const channel = await this.#openHarnessWs(ctx.env.RUNTIME_ROOM, ctx.session_id, binding.runtime_id, ctx.tenant_id);
    if (!channel) throw new Error("Could not connect to the runner to interrupt its pending turn");
    try {
      const attached = await channel.take((frame) => frame.type === "attached", 5_000);
      if (attached.daemon_online === false) throw new Error("Runner is offline; its pending turn has not been interrupted");
      for (const turnId of new Set(requests.map((request) => request.turnId))) {
        // The host already owns this turn. Starting or prompting here could
        // create new work while handling a request to stop it.
        channel.ws.send(JSON.stringify({ type: "session.cancel", turn_id: turnId }));
        const result = await channel.take((frame) => frame.type === "session.error" || frame.type === "session.complete" && frame.turn_id === turnId, 30_000);
        if (result.type === "session.error") throw new Error(String(result.message ?? "Runner interrupt failed"));
      }
      return requests.map((request) => request.id);
    } finally {
      channel.dispose();
      try { channel.ws.close(1000, "interrupt finished"); } catch { /* already closed */ }
    }
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;
    const binding = ctx.agent.runtime_binding;
    if (!binding) {
      this.#emitError(runtime, "AcpProxyHarness requires agent.runtime_binding to be set");
      return;
    }

    const env = ctx.env as unknown as { RUNTIME_ROOM?: DurableObjectNamespace };
    if (!env.RUNTIME_ROOM) {
      this.#emitError(runtime, "RUNTIME_ROOM binding missing on agent worker — check wrangler.jsonc cross-script DO binding");
      return;
    }

    const sid = ctx.session_id ?? "";
    if (!sid) {
      this.#emitError(runtime, "AcpProxyHarness needs ctx.session_id but it was not set");
      return;
    }

    const userText = extractUserText(ctx.userMessage);
    const resumed = userText ? null : runtimeActionResponse(runtime.history.getEvents() as unknown as ParsedFrame[]);
    if (!userText && !resumed) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    const turnId = resumed?.turnId ?? generateEventId();
    const seen: Record<string, number> = Object.assign(Object.create(null), resumed?.after);
    let channel = await this.#openHarnessWs(env.RUNTIME_ROOM, sid, binding.runtime_id, ctx.tenant_id,
      resumed?.after ? { turn_id: turnId, after: seen } : undefined);
    if (!channel) {
      this.#emitError(runtime, "Failed to attach to RuntimeRoom — runtime_id may be invalid or daemon offline");
      return;
    }

    let ws = channel.ws;
    let recoverable = false;
    let awaitingResponse = Boolean(resumed);
    const sendResponse = () => {
      if (resumed) channel!.send({ type: "session.response", turn_id: turnId, request_id: resumed.requestId, response: resumed.response });
    };
    const remember = (frame: ParsedFrame) => {
      const delivery = record(frame.delivery);
      if (typeof delivery.stream_id === "string" && Number.isSafeInteger(delivery.seq) && Number(delivery.seq) > 0) {
        seen[delivery.stream_id] = Math.max(seen[delivery.stream_id] ?? 0, Number(delivery.seq));
      }
    };
    const take = async (predicate: (frame: ParsedFrame) => boolean, timeoutMs = 0): Promise<ParsedFrame> => {
      for (;;) {
        try {
          const frame = await channel!.take(predicate, timeoutMs);
          const delivery = record(frame.delivery);
          if (typeof delivery.stream_id === "string" && typeof delivery.seq === "number" && delivery.seq <= (seen[delivery.stream_id] ?? 0)) continue;
          return frame;
        } catch (error) {
          if (!(error instanceof RuntimeConnectionError) || !recoverable) throw error;
          channel!.dispose();
          // Reconnect the observer of this turn. Never repeat session.prompt:
          // the runner may still be executing after either socket disappears.
          let delay = 250;
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            const replacement = await this.#openHarnessWs(env.RUNTIME_ROOM!, sid, binding.runtime_id, ctx.tenant_id, { turn_id: turnId, after: seen });
            if (replacement) {
              try {
                const attached = await replacement.take((frame) => frame.type === "attached", 5_000);
                if (!Array.isArray(attached.capabilities) || !attached.capabilities.includes("durable_session_events_v1")) throw new Error("Runtime relay no longer supports output recovery");
                channel = replacement; ws = replacement.ws;
                if (runtime.abortSignal?.aborted) abortHandler();
                else if (awaitingResponse) sendResponse();
                break;
              } catch { replacement.dispose(); replacement.ws.close(); }
            }
            delay = Math.min(delay * 2, 5_000);
          }
        }
      }
    };
    const translator = new AcpTranslator(runtime, {
      model: typeof ctx.agent.model === "string" ? ctx.agent.model : ctx.agent.model.id,
    });
    const abortHandler = () => {
      channel!.send({ type: "session.cancel", turn_id: turnId });
    };
    runtime.abortSignal?.addEventListener("abort", abortHandler);

    try {
      // Wait for the DO's "attached" handshake (synthetic, daemon may also
      // have replayed session.ready). After that the daemon is ready to
      // receive session.start / session.prompt.
      const attached = await channel.take((m) => m.type === "attached", 5_000);
      if (attached.daemon_online === false) throw new Error("Runtime daemon is offline");

      // Idempotent session.start — daemon spawns ACP child on first call,
      // short-circuits to session.ready on subsequent calls for the same sid.
      channel.send({
        type: "session.start",
        agent_id: binding.acp_agent_id,
      });
      await channel.take((m) => m.type === "session.ready" || m.type === "session.error", 60_000)
        .then((m) => {
          if (m.type === "session.error") throw new Error(`session.start failed: ${m.message ?? "unknown"}`);
        });

      recoverable = Array.isArray(attached.capabilities) && attached.capabilities.includes("durable_session_events_v1");
      if (resumed) sendResponse();
      else channel.send({ type: "session.prompt", turn_id: turnId, text: userText });

      // Consume in order: completing while asynchronous translation is still
      // pending can lose the final text/usage. The inbox is installed before
      // accept/start, so early callbacks and reconnect replays are retained.
      for (;;) {
        const frame = await take((frame) => frame.type === "session.error" || frame.turn_id === turnId, awaitingResponse ? 30_000 : 0);
        if (frame.type === "session.error") throw new Error(String(frame.message ?? "session.error from runtime"));
        if (frame.type === "session.complete") break;
        if (frame.type !== "session.event") continue;
        const event = record(frame.event);
        if (event.type === "client.response" && event.request_id === resumed?.requestId) {
          awaitingResponse = false;
          runtime.consumePendingConfirmation?.(resumed!.requestId);
          remember(frame);
          continue;
        }
        if (event.type === "client.request" && event.method === "session/request_permission" && typeof event.request_id === "string") {
          if (event.request_id === resumed?.requestId) continue;
          const params = record(event.params);
          if (!Array.isArray(params.options)) throw new Error("Invalid runner permission request");
          await translator.flush("completed");
          remember(frame);
          runtime.broadcast({ type: "agent.custom_tool_use", id: event.request_id,
            name: String(record(params.toolCall).title ?? "Runner permission"),
            input: { _openma: { type: "runtime_action", method: event.method, turn_id: turnId, params,
              ...(Object.keys(seen).length ? { after: { ...seen } } : {}),
            } },
          } as SessionEvent);
          (runtime.pendingConfirmations ??= []).push(event.request_id);
          return; // ACP remains blocked on its original callback.
        }
        await translator.consume(frame as never);
        remember(frame);
      }

      await translator.flush("completed");
    } catch (err) {
      const aborted = runtime.abortSignal?.aborted ?? false;
      const msg = err instanceof Error ? err.message : String(err);
      if (!aborted) {
        await translator.consume({ type: "promptError", error: msg });
      }
      await translator.flush(aborted ? "aborted" : "completed");
      if (aborted) {
        log({ op: "acp_proxy.aborted", session_id: sid }, "user-aborted");
      } else {
        logError({ op: "acp_proxy.turn_failed", session_id: sid, err: msg }, "turn failed");
        this.#emitError(runtime, msg);
      }
    } finally {
      runtime.abortSignal?.removeEventListener("abort", abortHandler);
      channel.dispose();
      try { ws.close(1000, "turn done"); } catch { /* already closed */ }
    }
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }

  async #openHarnessWs(
    runtimeRoom: DurableObjectNamespace,
    sid: string,
    runtimeId: string,
    tenantId?: string,
    replay?: { turn_id: string; after: Record<string, number> },
  ): Promise<FrameInbox | null> {
    // Direct DO access. The DO class lives in the main worker but DOs are
    // namespace-scoped; the cross-script binding in wrangler.jsonc lets the
    // agent worker hold a stub without going through main as a service.
    // Headers (`x-attach-role`, `x-session-id`) match what the now-removed
    // /v1/oma/internal/runtime-attach-harness endpoint used to inject — DO's
    // fetch handler already keys off them. `x-harness-tenant` is the
    // step-2 multi-tenant addition — RuntimeRoom stashes it per-sid and
    // uses it to inject `tenant_id` into outbound session-scoped frames so
    // v2-aware daemons can pick the right per-tenant API key. Omitted when
    // SessionDO didn't populate ctx.tenant_id (legacy callers / tests);
    // RuntimeRoom tolerates absence in this step.
    try {
      const stub = runtimeRoom.get(runtimeRoom.idFromName(runtimeId));
      const headers: Record<string, string> = {
        Upgrade: "websocket",
        "x-attach-role": "harness",
        "x-session-id": sid,
      };
      if (tenantId) headers["x-harness-tenant"] = tenantId;
      if (replay) headers["x-runtime-replay"] = JSON.stringify(replay);
      const res = await stub.fetch(
        new Request("http://runtime-room/_attach_harness", { headers }),
      );
      if (res.status !== 101 || !res.webSocket) {
        logWarn(
          { op: "acp_proxy.attach_failed", status: res.status, sid, runtime_id: runtimeId },
          "harness WS attach didn't upgrade",
        );
        return null;
      }
      const channel = new FrameInbox(res.webSocket as unknown as AttachedWs);
      res.webSocket.accept();
      return channel;
    } catch (e) {
      logError({ op: "acp_proxy.attach_throw", err: String(e), sid }, "harness WS attach threw");
      return null;
    }
  }
}

function extractUserText(msg: UserMessageEvent): string {
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

interface ParsedFrame {
  type?: string;
  message?: string;
  [k: string]: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function runtimeActionResponse(events: ParsedFrame[]) {
  const response = [...events].reverse().find((event) => event.type === "user.custom_tool_result");
  if (!response || typeof response.custom_tool_use_id !== "string") return null;
  const request = events.find((event) => event.type === "agent.custom_tool_use" && event.id === response.custom_tool_use_id);
  const action = record(record(request?.input)._openma);
  if (action.type !== "runtime_action" || action.method !== "session/request_permission" || typeof action.turn_id !== "string") return null;
  const content = Array.isArray(response.content) ? response.content.map((block) => record(block).type === "text" ? String(record(block).text ?? "") : "").join("") : "";
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const after = Object.fromEntries(Object.entries(record(action.after)).filter(([, seq]) => Number.isSafeInteger(seq) && Number(seq) >= 0)) as Record<string, number>;
  return { requestId: response.custom_tool_use_id, turnId: action.turn_id, response: value,
    ...(Object.keys(after).length ? { after } : {}),
  };
}

class RuntimeConnectionError extends Error {}

class FrameInbox {
  #frames: ParsedFrame[] = [];
  #closed = false;
  #wake?: () => void;
  #message = (event: MessageEvent | CloseEvent | Event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return;
    try { this.#frames.push(JSON.parse(data)); } catch { return; }
    this.#wake?.();
  };
  #close = () => { this.#closed = true; this.#wake?.(); };
  constructor(readonly ws: AttachedWs) {
    ws.addEventListener("message", this.#message);
    ws.addEventListener("close", this.#close);
    ws.addEventListener("error", this.#close);
  }
  send(frame: ParsedFrame): void {
    try { this.ws.send(JSON.stringify(frame)); }
    catch {
      // An exception does not tell us whether the peer accepted the bytes.
      // Let the consumer reconnect its output stream without repeating input.
      this.#close();
      try { this.ws.close(); } catch { /* already lost */ }
    }
  }
  async take(predicate: (frame: ParsedFrame) => boolean, timeoutMs = 0): Promise<ParsedFrame> {
    const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index >= 0) return this.#frames.splice(index, 1)[0]!;
      if (this.#closed) throw new RuntimeConnectionError("WS to RuntimeRoom closed before turn complete");
      await new Promise<void>((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => { this.#wake = undefined; reject(new Error("Runtime response timed out")); }, Math.max(0, deadline - Date.now())) : undefined;
        this.#wake = () => { if (timer) clearTimeout(timer); this.#wake = undefined; resolve(); };
      });
    }
  }
  dispose(): void {
    this.#close();
    this.ws.removeEventListener?.("message", this.#message);
    this.ws.removeEventListener?.("close", this.#close);
    this.ws.removeEventListener?.("error", this.#close);
  }
}
