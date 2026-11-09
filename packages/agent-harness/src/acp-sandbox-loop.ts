import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import {
  PLATFORM_ROOT,
  supportsDuplexProcess,
  workspaceRootOf,
} from "@open-managed-agents/sandbox";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

import { answerAcpPermission } from "./acp-permission";
import { AcpTranslator } from "./acp-translate";
import type {
  HarnessContext,
  HarnessDisposeReason,
  HarnessInterface,
  HarnessRuntime,
} from "./interface";
import {
  captureAcpSandboxAgentState,
  hasRequiredAcpSandboxAgentState,
  installAcpSandboxAgent,
  managedMcpProxyFromWorkEnvironment,
  materializeAcpSandboxAgentState,
  materializeHostedInferenceConfigFiles,
  prepareAcpSandboxAgent,
  projectAcpSandboxMcpServers,
  releaseAcpSandboxAgentState,
  restoreAcpSandboxAgentState,
  type AcpSandboxAgentPreparation,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import { InferenceEndpointsMissingError } from "@open-managed-agents/acp-runtime/inference-config";
import { wireHostedInferenceForAcpLaunch } from "@open-managed-agents/harness-inference-adapters";
import {
  buildAcpSemanticRecoveryPrompt,
  type AcpSemanticRecoveryReason,
} from "./acp-recovery";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
interface AcpSandboxCheckpoint {
  version: 1;
  configurationSha256: string;
  acpSessionId: string;
}

/** Runs an ACP-compatible agent inside the session Sandbox while OpenMA keeps
 * ownership of session lifecycle, cancellation and canonical events.
 *
 * The child lives one execution (design §0.6): when the prompt returns, the
 * child is closed, then its native state is saved, and only then does the
 * core's idle timing start. The next execution starts a child that resumes
 * the native ACP session (its token is issued per execution, so a resident
 * child would hold an expired one). Keeping the sandbox up during a turn is
 * the core's job (CF container activity, Node sandbox heartbeat), not this
 * harness's; `idle_timeout_ms` belongs to acp-proxy only. */
export class AcpSandboxHarness implements HarnessInterface {
  #session: AcpSession | null = null;
  #configKey: string | null = null;
  #resumeAcpSessionId: string | null = null;
  #checkpointLoadedForKey: string | null = null;
  #runtime: HarnessRuntime | null = null;
  #preparation: AcpSandboxAgentPreparation | null = null;
  #semanticRecoveryReason: AcpSemanticRecoveryReason | null = null;

  async onSessionInit(_ctx: HarnessContext, _runtime: HarnessRuntime): Promise<void> {
    // Platform context is delivered with the first prompt of each fresh ACP
    // session, never written into the task's working directory (ADR 0016).
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
    if (!config?.agent?.command && !config?.agent?.registry) {
      this.#emitError(runtime, "AcpSandboxHarness requires agent.acp.agent.command or agent.acp.agent.registry");
      return;
    }
    if (!supportsDuplexProcess(runtime.sandbox)) {
      this.#emitError(runtime, "selected sandbox does not support duplex ACP processes");
      return;
    }
    if (!ctx.session_id) {
      this.#emitError(runtime, "AcpSandboxHarness requires a session_id for native state isolation");
      return;
    }

    const text = extractUserText(ctx.userMessage);
    if (!text) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    let preparation: AcpSandboxAgentPreparation;
    try {
      preparation = prepareAcpSandboxAgent({
        sessionId: ctx.session_id,
        agent: config.agent,
        workspaceRoot: await workspaceRootOf(runtime.sandbox),
        stateRoot: `${PLATFORM_ROOT}/harness-state`,
      });
    } catch (error) {
      this.#emitError(runtime, error instanceof Error ? error.message : String(error));
      return;
    }
    const stateBinding = preparation.binding;
    const configKey = JSON.stringify({ config, stateAdapter: stateBinding.adapterId });
    await materializeAcpSandboxAgentState(runtime.sandbox, preparation);
    if (!this.#session && this.#configKey !== null && this.#configKey !== configKey) {
      // The previous execution's child ran another configuration: its ACP
      // session is not this one's to resume.
      this.#configKey = null;
      this.#resumeAcpSessionId = null;
      this.#checkpointLoadedForKey = null;
    }
    if (!this.#session && this.#checkpointLoadedForKey !== configKey) {
      this.#checkpointLoadedForKey = configKey;
      this.#semanticRecoveryReason = null;
      this.#resumeAcpSessionId = await this.#loadCheckpoint(
        runtime,
        configKey,
        stateBinding.checkpointPath,
      );
    }
    if (this.#session && (this.#configKey !== configKey || !this.#session.isAlive())) {
      this.#resumeAcpSessionId = this.#configKey === configKey
        ? this.#session.acpSessionId || null
        : null;
      await this.#session.dispose();
      this.#session = null;
    }

    if (
      !this.#session &&
      this.#resumeAcpSessionId &&
      stateBinding.resume === "native-and-acp" &&
      !(await hasRequiredAcpSandboxAgentState(runtime.sandbox, preparation))
    ) {
      this.#resumeAcpSessionId = null;
      this.#semanticRecoveryReason = "native-state-missing";
    } else if (
      !this.#session &&
      this.#resumeAcpSessionId &&
      stateBinding.resume === "native-and-acp"
    ) {
      await restoreAcpSandboxAgentState(runtime.sandbox, preparation);
    }

    const translator = new AcpTranslator(runtime, {
      model: typeof ctx.agent.model === "string" ? ctx.agent.model : ctx.agent.model.id,
    });
    let freshAcpSession = false;
    try {
      if (!this.#session) {
        freshAcpSession = !this.#resumeAcpSessionId;
        // Harbor-style install: pinned registry agents get their launcher
        // before spawn. A failure rejects into the turn error below; it never
        // falls back to a bare command or an unpinned package.
        preparation = await installAcpSandboxAgent(runtime.sandbox, preparation);
        const acpRuntime = createAcpRuntime({
          type: "sandbox",
          sandbox: runtime.sandbox,
        });
        const managedMcpProxy = ctx.env.mcpProxy
          ?? managedMcpProxyFromWorkEnvironment(ctx.env);
        const modelHandle = typeof ctx.agent.model === "string"
          ? ctx.agent.model
          : ctx.agent.model.id;
        let launchEnv = preparation.launch.env;
        const hostedInference = ctx.env.hostedInference;
        if (hostedInference) {
          const inferenceModel = hostedInference.model;
          if (!inferenceModel?.providerId) {
            throw new InferenceEndpointsMissingError();
          }
          const capability = {
            gatewayBaseUrl: hostedInference.gatewayBaseUrl
              ?? managedMcpProxy?.gatewayBaseUrl,
            sessionsToken: hostedInference.sessionsToken
              ?? managedMcpProxy?.sessionsToken,
          };
          if (!capability.gatewayBaseUrl || !capability.sessionsToken) {
            throw new InferenceEndpointsMissingError();
          }
          const hosted = wireHostedInferenceForAcpLaunch({
            sessionId: ctx.session_id,
            gatewayBaseUrl: capability.gatewayBaseUrl,
            sessionsToken: capability.sessionsToken,
            env: preparation.launch.env,
            agent: preparation.binding.agent,
            nativePath: preparation.binding.nativePath,
            model: {
              wireModel: inferenceModel.wireModel ?? modelHandle,
              providerId: inferenceModel.providerId,
              baseUrl: inferenceModel.baseUrl,
              protocolEndpoints: inferenceModel.protocolEndpoints,
            },
          });
          await materializeHostedInferenceConfigFiles(runtime.sandbox, hosted.files);
          launchEnv = hosted.env;
        }
        const mcpServers = projectAcpSandboxMcpServers({
          sessionId: ctx.session_id,
          ...(managedMcpProxy === null ? {} : {
            gatewayBaseUrl: managedMcpProxy.gatewayBaseUrl,
            sessionsToken: managedMcpProxy.sessionsToken,
          }),
          servers: ctx.agent.mcp_servers ?? [],
        });
        this.#session = await acpRuntime.start({
          agent: {
            ...preparation.launch,
            env: launchEnv,
          },
          restart: config.restart
            ? {
                mode: config.restart.mode,
                maxRestarts: config.restart.max_restarts,
                windowMs: config.restart.window_ms,
              }
            : { mode: "on-crash", maxRestarts: 3, windowMs: 60_000 },
          perTurnTimeoutMs:
            config.per_turn_timeout_ms ?? DEFAULT_TURN_TIMEOUT_MS,
          ...(this.#resumeAcpSessionId
            ? { resumeAcpSessionId: this.#resumeAcpSessionId }
            : {}),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
          // Without this callback ACP cancels every permission request, so
          // the agent could not run any tool that asks (e.g. Claude's Bash).
          clientCallbacks: {
            requestPermission: async (params) => answerAcpPermission(ctx.agent, params),
          },
        });
        this.#configKey = configKey;
        this.#preparation = preparation;
        // The engine falls back to session/new when the agent cannot resume
        // or load (a new id): the child lives one execution, so carry the
        // conversation over from canonical history instead of losing it.
        if (this.#resumeAcpSessionId && this.#session.acpSessionId !== this.#resumeAcpSessionId) {
          this.#semanticRecoveryReason ??= "resume-unsupported";
        }
        this.#resumeAcpSessionId = this.#session.acpSessionId || null;
        await this.#saveCheckpoint(
          runtime,
          configKey,
          this.#session.acpSessionId,
          stateBinding.checkpointPath,
        );
      }

      const session = this.#session;
      const recoveryReason = this.#semanticRecoveryReason;
      const turnText = recoveryReason
        ? buildAcpSemanticRecoveryPrompt(
            ctx.acpRecoveryHistory ?? runtime.history.getEvents(),
            ctx.userMessage,
            { reason: recoveryReason },
          )
        : text;
      const platformPrompt = ctx.systemPrompt.trimEnd();
      const promptText = (freshAcpSession || recoveryReason) && platformPrompt
        ? `<openma-platform>\n${platformPrompt}\n</openma-platform>\n\n${turnText}`
        : turnText;
      if (recoveryReason) {
        runtime.broadcast({
          type: "session.warning",
          source: "acp_semantic_recovery",
          message: "Agent-native session state was unavailable; continued from canonical OpenMA history.",
          details: {
            reason: recoveryReason,
            adapter_id: stateBinding.adapterId,
          },
        });
      }
      const consumePrompt = async (abortSignal: AbortSignal) => {
        for await (const update of session.prompt(promptText, { abortSignal })) {
          await translator.consumePromptItem(update, session.acpSessionId);
        }
      };
      const controller = new AbortController();
      const onAbort = () => controller.abort(runtime.abortSignal?.reason);
      if (runtime.abortSignal?.aborted) onAbort();
      else runtime.abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        await consumePrompt(controller.signal);
      } finally {
        runtime.abortSignal?.removeEventListener("abort", onAbort);
      }
      // Empty output is not a successful turn. Adapter failures arrive as ACP
      // errors; do not inspect private transcripts to support obsolete adapters.
      if (!translator.producedOutput && !runtime.abortSignal?.aborted) {
        throw new Error("ACP agent ended the turn without any output; check its model configuration");
      }
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed");
      this.#semanticRecoveryReason = null;
    } catch (error) {
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed");
      if (!runtime.abortSignal?.aborted) {
        this.#emitError(
          runtime,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      await this.#endExecution(runtime, preparation);
    }
  }

  /** Execution end: close the child, then save its native state (never
   * under a live process). The ACP session id is kept for the next resume. */
  async #endExecution(runtime: HarnessRuntime, preparation: AcpSandboxAgentPreparation): Promise<void> {
    const session = this.#session;
    if (!session) return;
    this.#resumeAcpSessionId = session.acpSessionId || this.#resumeAcpSessionId;
    try {
      await session.dispose();
      this.#session = null;
    } catch (error) {
      // Exit not confirmed: keep the child as the barrier so the host's
      // dispose also rejects instead of touching state under it.
      this.#emitError(runtime, error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      await captureAcpSandboxAgentState(runtime.sandbox, preparation);
    } catch (error) {
      this.#emitError(runtime, error instanceof Error ? error.message : String(error));
    }
  }

  async dispose(reason: HarnessDisposeReason = "destroy"): Promise<void> {
    const session = this.#session;
    const runtime = this.#runtime;
    const preparation = this.#preparation;
    this.#session = null;
    this.#configKey = null;
    this.#resumeAcpSessionId = null;
    this.#checkpointLoadedForKey = null;
    this.#runtime = null;
    this.#preparation = null;
    this.#semanticRecoveryReason = null;
    // A failed dispose means exit was not confirmed. Do not race the live
    // process by copying or deleting any of its native state.
    await session?.dispose();
    let failure: unknown;
    // A host shutdown is a placement change, not logical session deletion.
    // Keep the native ACP id and session artifacts under /oma/harness-state
    // (ADR 0016) so a replacement host can resume after restoring the
    // workspace checkpoint, which carries that directory alongside the
    // workspace root. Explicit logical destruction or harness replacement removes
    // the complete isolated session root; configuration and cache files must
    // not outlive the session merely because the agent wrote them beside its
    // native transcript.
    if (runtime && preparation) {
      if (reason !== "destroy") {
        try {
          await captureAcpSandboxAgentState(runtime.sandbox, preparation);
        } catch (error) {
          failure ??= error;
        }
      }
      try {
        await releaseAcpSandboxAgentState(runtime.sandbox, preparation, reason);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async #loadCheckpoint(
    runtime: HarnessRuntime,
    configKey: string,
    checkpointPath: string,
  ): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await runtime.sandbox.readFile(checkpointPath));
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
    checkpointPath: string,
  ): Promise<void> {
    if (!acpSessionId) return;
    const checkpoint: AcpSandboxCheckpoint = {
      version: 1,
      configurationSha256: await configurationDigest(configKey),
      acpSessionId,
    };
    await runtime.sandbox.writeFile(
      checkpointPath,
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
