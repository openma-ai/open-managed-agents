import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import {
  runWithSandboxLease,
  SandboxLeaseLostError,
  supportsDuplexProcess,
  supportsSandboxRuntime,
} from "@open-managed-agents/sandbox";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

import { AcpTranslator } from "./acp-translate";
import type {
  HarnessContext,
  HarnessDisposeReason,
  HarnessInterface,
  HarnessRuntime,
} from "./interface";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SANDBOX_LEASE_TTL_MS = 90_000;
const DEFAULT_SANDBOX_HEARTBEAT_MS = 30_000;
const ACP_CHECKPOINT_PATH = "/workspace/.openma/acp-session-checkpoint.json";

interface AcpSandboxCheckpoint {
  version: 1;
  configurationSha256: string;
  acpSessionId: string;
}

/** Runs an ACP-compatible agent inside the session Sandbox while OpenMA keeps
 * ownership of session lifecycle, cancellation and canonical events. */
export class AcpSandboxHarness implements HarnessInterface {
  #session: AcpSession | null = null;
  #configKey: string | null = null;
  #resumeAcpSessionId: string | null = null;
  #checkpointLoadedForKey: string | null = null;
  #runtime: HarnessRuntime | null = null;

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
    this.#runtime = runtime;
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
    if (!this.#session && this.#checkpointLoadedForKey !== configKey) {
      this.#checkpointLoadedForKey = configKey;
      this.#resumeAcpSessionId = await this.#loadCheckpoint(runtime, configKey);
    }
    if (this.#session && (this.#configKey !== configKey || !this.#session.isAlive())) {
      this.#resumeAcpSessionId = this.#configKey === configKey
        ? this.#session.acpSessionId || null
        : null;
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
          ...(this.#resumeAcpSessionId
            ? { resumeAcpSessionId: this.#resumeAcpSessionId }
            : {}),
        });
        this.#configKey = configKey;
        this.#resumeAcpSessionId = this.#session.acpSessionId || null;
        await this.#saveCheckpoint(runtime, configKey, this.#session.acpSessionId);
      }

      const session = this.#session;
      const consumePrompt = async (abortSignal: AbortSignal) => {
        for await (const update of session.prompt(text, { abortSignal })) {
          await translator.consume({
            type: "session.event",
            event: {
              sessionId: session.acpSessionId,
              update,
            },
          } as never);
        }
      };
      if (
        supportsSandboxRuntime(runtime.sandbox) &&
        runtime.sandbox.runtimeCapabilities().lease
      ) {
        await runWithSandboxLease(
          runtime.sandbox,
          {
            ttlMs: DEFAULT_SANDBOX_LEASE_TTL_MS,
            intervalMs: DEFAULT_SANDBOX_HEARTBEAT_MS,
            signal: runtime.abortSignal,
          },
          consumePrompt,
        );
      } else {
        const fallbackController = new AbortController();
        const onAbort = () => fallbackController.abort(runtime.abortSignal?.reason);
        if (runtime.abortSignal?.aborted) onAbort();
        else runtime.abortSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          await consumePrompt(fallbackController.signal);
        } finally {
          runtime.abortSignal?.removeEventListener("abort", onAbort);
        }
      }
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed");
    } catch (error) {
      const leaseLost = error instanceof SandboxLeaseLostError;
      const aborted = leaseLost || (runtime.abortSignal?.aborted ?? false);
      if (leaseLost && this.#session) {
        const fencedSession = this.#session;
        this.#resumeAcpSessionId = fencedSession.acpSessionId || null;
        this.#session = null;
        await fencedSession.dispose().catch(() => undefined);
      }
      await translator.flush(aborted ? "aborted" : "completed");
      if (!runtime.abortSignal?.aborted) {
        this.#emitError(
          runtime,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async dispose(reason: HarnessDisposeReason = "destroy"): Promise<void> {
    const session = this.#session;
    const runtime = this.#runtime;
    this.#session = null;
    this.#configKey = null;
    this.#resumeAcpSessionId = null;
    this.#checkpointLoadedForKey = null;
    this.#runtime = null;
    await session?.dispose();
    // A host shutdown is a placement change, not logical session deletion.
    // Keep the native ACP id in /workspace so the replacement host can resume
    // after restoring the provider filesystem checkpoint. Explicit destroy and
    // harness replacement intentionally invalidate it.
    if (reason !== "shutdown") {
      await runtime?.sandbox.exec(`rm -f ${ACP_CHECKPOINT_PATH}`).catch(() => undefined);
    }
  }

  async #loadCheckpoint(
    runtime: HarnessRuntime,
    configKey: string,
  ): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await runtime.sandbox.readFile(ACP_CHECKPOINT_PATH));
    } catch {
      return null;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { configurationSha256?: unknown }).configurationSha256 !== "string" ||
      typeof (parsed as { acpSessionId?: unknown }).acpSessionId !== "string" ||
      (parsed as { acpSessionId: string }).acpSessionId.length === 0
    ) return null;
    const expected = await configurationDigest(configKey);
    return (parsed as AcpSandboxCheckpoint).configurationSha256 === expected
      ? (parsed as AcpSandboxCheckpoint).acpSessionId
      : null;
  }

  async #saveCheckpoint(
    runtime: HarnessRuntime,
    configKey: string,
    acpSessionId: string,
  ): Promise<void> {
    if (!acpSessionId) return;
    const checkpoint: AcpSandboxCheckpoint = {
      version: 1,
      configurationSha256: await configurationDigest(configKey),
      acpSessionId,
    };
    await runtime.sandbox.writeFile(
      ACP_CHECKPOINT_PATH,
      `${JSON.stringify(checkpoint)}\n`,
    );
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }
}

async function configurationDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
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
