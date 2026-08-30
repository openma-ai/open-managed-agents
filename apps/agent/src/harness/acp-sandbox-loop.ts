import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { supportsDuplexProcess } from "@open-managed-agents/sandbox";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

import { AcpTranslator } from "./acp-translate";
import type {
  HarnessContext,
  HarnessInterface,
  HarnessRuntime,
} from "./interface";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/** Runs an ACP-compatible agent inside the session Sandbox while OpenMA keeps
 * ownership of session lifecycle, cancellation and canonical events. */
export class AcpSandboxHarness implements HarnessInterface {
  #session: AcpSession | null = null;
  #configKey: string | null = null;

  async onSessionInit(ctx: HarnessContext, runtime: HarnessRuntime): Promise<void> {
    const prompt = ctx.systemPrompt.trimEnd();
    if (prompt) {
      await runtime.sandbox.writeFile("/workspace/AGENTS.md", `${prompt}\n`);
    }
  }

  shouldCompact(): boolean {
    return false;
  }

  async compact(): Promise<void> {}

  deriveModelContext(): never[] {
    return [];
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;
    const config = ctx.agent.acp;
    if (!config?.agent?.command) {
      this.#emitError(runtime, "AcpSandboxHarness requires agent.acp.agent.command");
      return;
    }
    if (!supportsDuplexProcess(runtime.sandbox)) {
      this.#emitError(runtime, "selected sandbox does not support duplex ACP processes");
      return;
    }

    const text = extractUserText(ctx.userMessage);
    if (!text) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    const configKey = JSON.stringify(config);
    if (this.#session && (this.#configKey !== configKey || !this.#session.isAlive())) {
      await this.#session.dispose();
      this.#session = null;
    }

    const translator = new AcpTranslator(runtime);
    try {
      if (!this.#session) {
        const acpRuntime = createAcpRuntime({
          type: "sandbox",
          sandbox: runtime.sandbox,
        });
        this.#session = await acpRuntime.start({
          agent: {
            ...config.agent,
            cwd: config.agent.cwd ?? "/workspace",
          },
          restart: config.restart
            ? {
                mode: config.restart.mode,
                maxRestarts: config.restart.max_restarts,
                windowMs: config.restart.window_ms,
              }
            : { mode: "on-crash", maxRestarts: 3, windowMs: 60_000 },
          idleTimeoutMs: config.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
          perTurnTimeoutMs:
            config.per_turn_timeout_ms ?? DEFAULT_TURN_TIMEOUT_MS,
        });
        this.#configKey = configKey;
      }

      for await (const update of this.#session.prompt(text, {
        abortSignal: runtime.abortSignal,
      })) {
        await translator.consume({
          type: "session.event",
          event: {
            sessionId: this.#session.acpSessionId,
            update,
          },
        } as never);
      }
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed");
    } catch (error) {
      const aborted = runtime.abortSignal?.aborted ?? false;
      await translator.flush(aborted ? "aborted" : "completed");
      if (!aborted) {
        this.#emitError(
          runtime,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async dispose(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.#configKey = null;
    await session?.dispose();
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }
}

function extractUserText(message: UserMessageEvent): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
