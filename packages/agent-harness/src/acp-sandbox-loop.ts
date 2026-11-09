import { harnessContextFromEvents, transitionHarnessContext, type HarnessContextState } from "@open-managed-agents/session-runtime-contract";
import { SessionExecutionLostError } from "@open-managed-agents/session-runtime-contract/coordination";
import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { readAcpSandboxAgentTurnError } from "@open-managed-agents/acp-runtime/sandbox-agent-turn-error";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import {
  SandboxGoneError,
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
  rebuildAcpContext,
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
  #runtime: HarnessRuntime | null = null;
  #preparation: AcpSandboxAgentPreparation | null = null;
  #semanticRecoveryReason: AcpSemanticRecoveryReason | null = null;
  #contextState: HarnessContextState = { state: "none" };

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
    this.#contextState = harnessContextFromEvents([...(ctx.acpRecoveryHistory ?? []), ...runtime.history.getEvents()]);
    const configKey = JSON.stringify({ config, stateAdapter: stateBinding.adapterId });
    await materializeAcpSandboxAgentState(runtime.sandbox, preparation);
    if (!this.#session && this.#configKey !== null && this.#configKey !== configKey) {
      // The previous execution's child ran another configuration: its ACP
      // session is not this one's to resume.
      this.#configKey = null;
      this.#resumeAcpSessionId = null;
    }
    if (!this.#session) {
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

    if (!this.#session && this.#resumeAcpSessionId && stateBinding.resume === "native-and-acp") {
      try {
        if (!(await hasRequiredAcpSandboxAgentState(runtime.sandbox, preparation))) throw new Error("native state missing");
        await restoreAcpSandboxAgentState(runtime.sandbox, preparation);
      } catch {
        this.#resumeAcpSessionId = null;
        this.#semanticRecoveryReason = "native-state-missing";
      }
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
        // Startup identity is not a successful context checkpoint. Persist it
        // before prompting so a failed first execution cannot look like none.
        if (this.#session.acpSessionId) {
          this.#contextState = {state:"started", acp_session_id:this.#session.acpSessionId, checkpoint_fingerprint:"", configuration_sha256:await configurationDigest(configKey)};
          runtime.broadcast({type:"session.warning", source:"oma.acp_context", message:"ACP session started; context checkpoint is not yet committed.", details:{...this.#contextState}});
        }
      }

      const session = this.#session;
      const recoveryReason = this.#semanticRecoveryReason;
      const recovery = recoveryReason ? await rebuildAcpContext(ctx, recoveryReason) : null;
      const turnText = recovery?.prompt ?? text;
      const platformPrompt = ctx.systemPrompt.trimEnd();
      const promptText = (freshAcpSession || recoveryReason) && platformPrompt
        ? `<openma-platform>\n${platformPrompt}\n</openma-platform>\n\n${turnText}`
        : turnText;
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
      if (translator.promptError !== null) throw new Error(translator.promptError);
      // An agent may end a failed turn as a plain end_turn (pi-acp does);
      // never report that as a silent success.
      if (!translator.producedOutput && !runtime.abortSignal?.aborted) {
        const detail = await readAcpSandboxAgentTurnError(runtime.sandbox, preparation).catch(() => null);
        throw new Error(detail === null
          ? "ACP agent ended the turn without any output; check its model configuration"
          : `ACP agent turn failed: ${detail}`);
      }
      await this.#saveCheckpoint(runtime, configKey, session.acpSessionId, stateBinding.checkpointPath);
      if (recoveryReason && recovery && this.#contextState.state !== "none") {
        this.#contextState = transitionHarnessContext(this.#contextState, { type: "rebuild", reason: recoveryReason, id: session.acpSessionId, fingerprint: this.#contextState.checkpoint_fingerprint });
        runtime.broadcast({
          type: "session.warning", source: "oma.acp_context",
          message: recovery.exceedsLimit
            ? "Agent context rebuilt from canonical history; history exceeded the recovery limit. " + (recovery.compacted ? "Existing compaction was applied." : "Compaction was unavailable; full history was retained without truncation.")
            : "Agent context rebuilt from canonical history because native resume was unavailable.",
          details: { ...this.#contextState, adapter_id: stateBinding.adapterId, compacted: recovery.compacted, history_characters: recovery.historyCharacters, exceeds_limit: recovery.exceedsLimit },
        });
      }
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed");
      this.#semanticRecoveryReason = null;
    } catch (error) {
      if (error instanceof SandboxGoneError) {
        this.#session = null; this.#runtime = null; this.#preparation = null;
        throw new SessionExecutionLostError("sandbox_gone");
      }
      if (!runtime.abortSignal?.aborted) await translator.consume({type:"promptError",error:error instanceof Error ? error.message : String(error)});
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed", error instanceof Error ? error.message : String(error));
      if (!runtime.abortSignal?.aborted) {
        if (error instanceof Error && (error.name === "AcpTurnTimeoutError" || error.name === "AcpPromptCancellationTimeoutError")) throw error;
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
      if (error instanceof SandboxGoneError) {
        this.#session = null; this.#runtime = null; this.#preparation = null;
        throw new SessionExecutionLostError("sandbox_gone");
      }
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
    const expected = await configurationDigest(configKey);
    const durableId = this.#contextState.state !== "none"
      && this.#contextState.state !== "started"
      && (!this.#contextState.configuration_sha256 || this.#contextState.configuration_sha256 === expected)
      ? this.#contextState.acp_session_id : null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await runtime.sandbox.readFile(checkpointPath));
    } catch {
      if (durableId) return durableId;
      if (this.#contextState.state !== "none") this.#semanticRecoveryReason = "checkpoint-unavailable";
      return null;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { configurationSha256?: unknown }).configurationSha256 !== "string" ||
      typeof (parsed as { acpSessionId?: unknown }).acpSessionId !== "string" ||
      (parsed as { acpSessionId: string }).acpSessionId.length === 0
    ) {
      if (durableId) return durableId;
      if (this.#contextState.state !== "none") this.#semanticRecoveryReason = "checkpoint-unavailable";
      return null;
    }
    const checkpoint = parsed as AcpSandboxCheckpoint;
    const fingerprint = await configurationDigest(JSON.stringify(checkpoint));
    if (checkpoint.configurationSha256 !== expected || (this.#contextState.state !== "none" && (this.#contextState.acp_session_id !== checkpoint.acpSessionId || this.#contextState.checkpoint_fingerprint !== fingerprint))) {
      this.#semanticRecoveryReason = "checkpoint-unavailable";
      return null;
    }
    return checkpoint.acpSessionId;
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
    this.#contextState = { ...transitionHarnessContext(this.#contextState, { type: "record_native", id: acpSessionId, fingerprint: await configurationDigest(JSON.stringify(checkpoint)) }), configuration_sha256: checkpoint.configurationSha256 } as HarnessContextState;
    runtime.broadcast({ type: "session.warning", source: "oma.acp_context", message: "Agent-native context checkpoint recorded.", details: { ...this.#contextState } });
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
