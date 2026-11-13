import { log as logInfo } from "@open-managed-agents/shared/log";
import { randomUUID } from "node:crypto";
import type { AcpSession, ClientCallbacks } from "@openma/common/acp-runtime";
import type { ManagedHarnessHttpScheduler, ManagedHarnessWireSession, RuntimeResourceScope } from "@openma/common/managed-runtime";
import { createWorkTurnFinalizer } from "./work-finalization-input-http.js";
import { createWorkInputsHttpClient } from "./work-inputs-http.js";
import { createWorkInputReader } from "./work-input-adapter.js";
import { createWorkOutputAdapter } from "./work-output-adapter.js";
import { createWorkPermissionBridge, type WorkPermissionBridge, type WorkPermissionScope } from "./work-permission-bridge.js";
import type { WorkControlChannel, WorkControlRuntime, WorkPermissionMode } from "./work-control-runtime.js";

interface WorkTurnConnection {
  scope: RuntimeResourceScope;
  harness: { id: string; version: string };
  workspacePath: string;
  apiBaseUrl: string;
  sessionsToken: string;
  signal: AbortSignal;
}
interface WorkTurnCoordinatorOptions {
  runtime: WorkControlRuntime;
  fallbackHarnessId: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  scheduler?: ManagedHarnessHttpScheduler;
  hasOutcomeEvaluator: boolean;
  onTurnAdmitted?(turnId: string): void;
  onPromptInput?(event: Readonly<Record<string,unknown>>): Promise<void>;
  onTurnPublished?(turnId: string): void;
  loadSession(session: ManagedHarnessWireSession): readonly Readonly<Record<string, unknown>>[];
  failRun(error: unknown): void;
}

/** One Work-run control owner. Native readiness, verified mode, exact input CAS,
 * original permission callbacks and output correlation share this lifetime.
 * Canonical input id, consumption/dispatch turn id and callback-owning turn id
 * remain distinct. No durable ownership or restart authority is created here. */
export interface WorkTurnCoordinator {
  reset(scope: WorkPermissionScope, signal: AbortSignal): void;
  selectNativeHarness(harnessId: string): void;
  nativeReady(session: AcpSession): void;
  requestPermission: NonNullable<ClientCallbacks["requestPermission"]>;
  connect(input: WorkTurnConnection): WorkControlChannel;
  checkpoint(turnId?: string): Promise<void>;
  afterTerminal(turnId: string): Promise<void>;
}

export function createWorkTurnCoordinator(options: WorkTurnCoordinatorOptions): WorkTurnCoordinator {
  const runtime = options.runtime;
  let workClaimScope!: WorkPermissionScope;
  let agentTools: readonly Readonly<Record<string, unknown>>[] = [];
  let nativeSession: AcpSession | undefined;
  let nativeHarnessId: string | undefined;
  let permissionBridge: WorkPermissionBridge | undefined;
  let callbackOwnerTurnId: string | undefined;
  let verifiedMode: string | undefined;
  let finalizer: ReturnType<typeof createWorkTurnFinalizer> | undefined;
  // Keep cancelled-turn mappings until its output drains; clearing them at
  // interrupt would turn the pending native notification into a second tool.
  const priorPermissionBridges: WorkPermissionBridge[] = [];
  const toolUseIdFor = (id: string) => permissionBridge?.toolUseIdFor(id)
    ?? priorPermissionBridges.find(bridge => bridge.toolUseIdFor(id) !== undefined)?.toolUseIdFor(id);
  const closePermissions = () => {
    if (permissionBridge) { permissionBridge.close(); priorPermissionBridges.push(permissionBridge); }
    permissionBridge = undefined;
    callbackOwnerTurnId = undefined;
  };
  const assertMode = () => {
    if (verifiedMode !== undefined && !nativeSession?.configOptions.some(option =>
      option.id === "mode" && option.type === "select" && option.currentValue === verifiedMode)) {
      closePermissions();
      options.failRun(new Error("Native permission mode drifted"));
      throw new Error("Native permission mode drifted");
    }
  };
  return {
    reset(scope, signal) {
      workClaimScope = scope;
      closePermissions();
      priorPermissionBridges.length = 0;
      nativeSession = undefined;
      verifiedMode = undefined;
      signal.addEventListener("abort", closePermissions, { once: true });
    },
    selectNativeHarness(harnessId) { nativeHarnessId = harnessId; },
    nativeReady(session) { nativeSession = session; verifiedMode = undefined; },
    async requestPermission(request) {
      assertMode();
      return permissionBridge?.requestPermission(request)
        ?? { outcome: { outcome: "cancelled" as const } };
    },
    connect(input) {
      // Capture this connection's authenticated claim; callbacks from an older
      // connection must not acquire a replacement claim through mutable state.
      const connectionClaim = workClaimScope;
      const client = createWorkInputsHttpClient({
        apiBaseUrl: input.apiBaseUrl, sessionId: input.scope.sessionId,
        sessionsToken: input.sessionsToken, fetch: options.fetch,
      });
      const reader = createWorkInputReader(client);
      // A native session accepts one mode setter at a time. Preserve input
      // admission order through mode verification and the consuming CAS.
      let admissionTail: Promise<void> = Promise.resolve();
      const admit = (operation: () => Promise<void>): Promise<void> => {
        const next = admissionTail.then(operation);
        admissionTail = next;
        void next.catch(() => undefined); // observed, but never recovered/replayed
        return next;
      };
      finalizer = createWorkTurnFinalizer({
        apiBaseUrl: input.apiBaseUrl,
        sessionId: input.scope.sessionId,
        sessionsToken: input.sessionsToken,
        fetch: options.fetch,
        signal: input.signal,
      });
      let activeRootProof: {inputId:string;turnId:string;expectedDocument:string} | undefined;
      let completingTurnId: string | undefined;
      // An attempted steer has already consumed its canonical input before RPC.
      // Keep exact identity locally only to forbid a second consume/fake root
      // on a later fallback gate. This is NOT a restart/acceptance receipt.
      const attemptedSteers = new Map<string, {root: NonNullable<typeof activeRootProof>; document:string; confirmed:boolean}>();
      // Common emits native child-created before it flushes the parent tool.
      // Hold only that dependent lane until its real parent tool/result reaches
      // the canonical output adapter; never synthesize a parent tool as proof.
      const deferredChildEvents: import("@openma/common/managed-runtime").ManagedRuntimeEventWire[] = [];
      const emittedParentTools = new Set<string>();
      const readyChildLanes = new Set<string>();
      const fetcher = options.fetch ?? globalThis.fetch;
      const outputUrl = `${input.apiBaseUrl.replace(/\/+$/u, "")}/v1/oma/sessions/${encodeURIComponent(input.scope.sessionId)}/runtime-events`;
      const output = createWorkOutputAdapter({
        toolUseIdFor,
        customToolNames: () => new Set(nativeHarnessId === "pi-acp" ? agentTools.filter(tool => tool.type === "custom" && typeof tool.name === "string").map(tool => tool.name as string) : []),
        async publish(events) {
          input.signal.throwIfAborted();
          const response = await fetcher(outputUrl, {
            method: "POST", redirect: "error", signal: input.signal,
            headers: { authorization: `Bearer ${input.sessionsToken}`, "content-type": "application/json" },
            body: JSON.stringify({ events, ...(activeRootProof ? {root:activeRootProof} : {}) }),
          });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Work output publication rejected: ${response.status}`); }
          const receipt: unknown = await response.json();
          if (!isRecord(receipt) || !Array.isArray(receipt.data) || receipt.data.length !== events.length ||
              receipt.data.some((entry, index) => !isRecord(entry) || entry.id !== events[index]?.id)) {
            throw new Error("Work output durable receipt is invalid");
          }
          input.signal.throwIfAborted();
          for(const event of events) if(event.type==="agent.custom_tool_use") logInfo({op:"acp.custom.pending",
            session_id:input.scope.sessionId,work_id:input.scope.workId,claim_generation:connectionClaim.generation,
            call_id:event.id},"Native custom call durably published; awaiting client result");
        },
      });
      const channel = runtime.createControlChannel({
        scope: input.scope,
        harness: input.harness,
        workspacePath: input.workspacePath,
        apiBaseUrl: input.apiBaseUrl,
        sessionsToken: input.sessionsToken,
        // Preserve common's active-turn accounting; serialize its canonical
        // output through the same fail-closed writer as original callbacks.
        fetch: async (url, init) => {
          if (String(url) !== outputUrl) return fetcher(url, init);
          const batch: {events: import("@openma/common/managed-runtime").ManagedRuntimeEventWire[]} = JSON.parse(String(init?.body));
          const projected = completingTurnId === undefined ? batch.events : batch.events.filter(event => event.type !== "session.status_idle");
          const rootEvents = projected.filter(event => !event.session_thread_id || event.session_thread_id === "sthr_primary");
          for (const event of rootEvents) if (event.type === "agent.tool_result" && typeof event.tool_use_id === "string") emittedParentTools.add(event.tool_use_id);
          deferredChildEvents.push(...projected.filter(event => event.session_thread_id && event.session_thread_id !== "sthr_primary"));
          if (deferredChildEvents.length > 200) throw new Error("Native child lineage buffer exceeded");
          const children: typeof projected = [];
          for (let index = 0; index < deferredChildEvents.length;) {
            const event = deferredChildEvents[index]!;
            if (event.type === "session.thread_created" && typeof event.parent_tool_use_id === "string" && emittedParentTools.has(event.parent_tool_use_id)) readyChildLanes.add(String(event.session_thread_id));
            if (readyChildLanes.has(String(event.session_thread_id))) {
              children.push(event);
              if (event.type === "agent.tool_use") emittedParentTools.add(event.id);
              deferredChildEvents.splice(index,1);
            } else index++;
          }
          if (completingTurnId && deferredChildEvents.length) throw new Error("Native child lineage has no canonical parent tool");
          await output.projected([...rootEvents,...children], batch.events.some(event =>
            event.type === "session.error" || event.type === "session.status_terminated" ||
            (event.type === "session.status_idle" && isRecord(event.stop_reason) && event.stop_reason.type === "end_turn")));
          if (completingTurnId !== undefined) await finalizer!.complete(completingTurnId);
          return Response.json({ recorded: batch.events.length });
        },
        eventIds: { next: () => `sevt_${randomUUID()}` },
        pollIntervalMs: options.pollIntervalMs,
        scheduler: options.scheduler,
        // A response loss is unknown, not license to repeat a mutation.
        retry: { maxAttempts: 1 },
        eventReader: reader,
        publishTurnStartBeforeDispatch: true,
        onSessionLoaded(session) {
          agentTools = options.loadSession(session);
        },
        onBeforeDispatch({ command, input: context, signal, kind }) {
          return admit(async () => {
            signal.throwIfAborted();
            if (!nativeSession) throw new Error("ACP session is not ready");
            if (context.event.type === "user.define_outcome" && !options.hasOutcomeEvaluator) {
              throw new Error("Work outcome evaluation port is unavailable");
            }
            const attempt = attemptedSteers.get(context.eventId);
            if (attempt) {
              signal.throwIfAborted();
              assertMode();
              if (kind !== "prompt" || !attempt.confirmed || activeRootProof !== attempt.root || callbackOwnerTurnId !== attempt.root.turnId || reader.input(context.event).expectedDocument !== attempt.document) {
                throw new Error("Unconfirmed or stale steer continuation");
              }
              await reader.verifyConsumption(context.event, attempt.root, signal);
              return; // same root, already consumed once, no activity re-admission
            }
            if (kind === "prompt") await options.onPromptInput?.(context.event);
            assertMode();
            const applied = await runtime.applyPermissionMode(nativeSession, {
              harnessId: nativeHarnessId ?? options.fallbackHarnessId,
              mode: globalPermissionMode(agentTools), toolModes: toolPermissionModes(agentTools), abortSignal: signal,
            });
            if (applied.status === "applied") verifiedMode = applied.nativeModeId;
            // Ungated always_allow has no native mode to drift-check.
            else if (applied.status === "inherent") verifiedMode = undefined;
            else throw new Error("Native permission mode was not verified");
            signal.throwIfAborted();
            const consumptionIdentity = reader.input(context.event);
            // inputId is the raw canonical event; turnId is its existing
            // source.execution_id ?? inputId. Neither is the Work claim id.
            if (context.eventId !== consumptionIdentity.inputId || command.turnId !== consumptionIdentity.turnId) {
              throw new Error("Canonical dispatch identity mismatch");
            }
            if (kind === "steer") {
              const consumingRoot = activeRootProof;
              if (!consumingRoot || callbackOwnerTurnId !== consumingRoot.turnId || consumingRoot.turnId === command.turnId) {
                throw new Error("Steer requires the active canonical consuming root");
              }
              // Consume the admission event under the ACTUAL active root without
              // changing activity admission, callback owner, finalizer or proof.
              // Unknown consume/dispatch outcomes never re-enter as a new prompt.
              attemptedSteers.set(context.eventId,{root:consumingRoot,document:consumptionIdentity.expectedDocument,confirmed:false});
              await client.consume({...consumptionIdentity, consumingTurnId:consumingRoot.turnId,
                rootInputId:consumingRoot.inputId, expectedRootDocument:consumingRoot.expectedDocument, signal});
              signal.throwIfAborted();
              return;
            }
            if (kind !== "prompt") throw new Error("Common dispatch kind capability is required");
            await client.consume({ ...consumptionIdentity, signal });
            finalizer!.admitted(command.turnId);
            options.onTurnAdmitted?.(command.turnId);
            activeRootProof = await reader.consumedRoot(context.event, signal);
            signal.throwIfAborted();
            if (!permissionBridge) {
              callbackOwnerTurnId = command.turnId;
              permissionBridge = createWorkPermissionBridge({
                scope: connectionClaim, turnId: command.turnId, acpSessionId: nativeSession.acpSessionId, rootProof: activeRootProof,
                signal, nextEventId: () => `sevt_${randomUUID()}`, now: () => new Date(),
                publish: ({events}) => output.canonical(events).catch(error => { options.failRun(error); throw error; }),
                consume: request => client.consume(request).catch(error => { options.failRun(error); throw error; }),
              });
            }
          });
        },
        async onFallbackOwner({command,signal}) {
          const context = command.input;
          const attempt = context && attemptedSteers.get(context.eventId);
          if (!attempt) return null;
          signal.throwIfAborted();
          if (activeRootProof !== attempt.root || callbackOwnerTurnId !== attempt.root.turnId || reader.input(context.event).expectedDocument !== attempt.document) throw new Error("Steer continuation owner changed");
          await reader.verifyConsumption(context.event, attempt.root, signal);
          attempt.confirmed = true;
          return attempt.root.turnId;
        },
        async onConsumed({input: context, acceptance}) {
          // A provider starting a new turn despite idleBehavior=promptRequired
          // cannot silently turn an absorbed input into another canonical root.
          if (attemptedSteers.has(context.eventId) && acceptance !== "injected" && !(acceptance === "prompt-dispatched" && attemptedSteers.get(context.eventId)!.confirmed)) {
            throw new Error("Steer did not remain in its canonical root; outcome requires authoritative recovery");
          }
        },
        async onInputSettled({input: context, turnId, signal}) {
          const consumptionIdentity = reader.input(context.event);
          if (context.eventId !== consumptionIdentity.inputId || turnId !== consumptionIdentity.turnId) throw new Error("Canonical settlement identity mismatch");
          await client.consume({...consumptionIdentity, signal});
        },
        async onToolConfirmation({event, signal}) {
          signal.throwIfAborted();
          if (!permissionBridge) return "rejected";
          assertMode();
          return permissionBridge.confirm({scope: connectionClaim, document: reader.input(event).expectedDocument});
        },
      });
      if (typeof channel.beforeDispatch !== "function") throw new Error("Common control channel has no dispatch gate");
      return {
        ...channel,
        async *commands(signal) {
          for await (const command of channel.commands(signal)) {
            if (command.type === "session.cancel" || command.type === "session.dispose") closePermissions();
            yield command;
          }
        },
        async publish(event) {
          assertMode();
          if (event.type === "session.complete") completingTurnId = event.turnId;
          try { await channel.publish(event); }
          finally { completingTurnId = undefined; }
          if (event.type === "session.disposed" || event.type === "session.error" ||
              (event.type === "session.complete" && event.turnId === callbackOwnerTurnId)) closePermissions();
          if (event.type === "session.complete" || event.type === "session.disposed") { priorPermissionBridges.length = 0; activeRootProof = undefined; emittedParentTools.clear(); readyChildLanes.clear(); }
        },
        async close() {
          closePermissions();
          input.signal.removeEventListener("abort", closePermissions);
          await channel.close();
        },
      };
    },
    async checkpoint(turnId) {
      if (!finalizer || !turnId) throw new Error("Work canonical checkpoint turn is unavailable");
      await finalizer.checkpoint(turnId);
    },
    async afterTerminal(turnId) {
      if (!finalizer) throw new Error("Work finalization connection is unavailable");
      await finalizer.publish(turnId);
      options.onTurnPublished?.(turnId);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every explicit per-tool / per-toolset policy. An ungated harness cannot
 * enforce any of them that is stricter than always_allow. */
function toolPermissionModes(tools: readonly Readonly<Record<string,unknown>>[]): string[] {
  const modes: string[] = [];
  for (const tool of tools) {
    const configs = Array.isArray(tool.configs) ? tool.configs : [];
    for (const config of [tool, ...configs]) {
      const policy = isRecord(config) ? config.permission_policy : undefined;
      if (isRecord(policy) && typeof policy.type === "string") modes.push(policy.type);
    }
  }
  return modes;
}

function globalPermissionMode(tools: readonly Readonly<Record<string,unknown>>[]): WorkPermissionMode {
  const toolset = tools.find(tool => tool.type === "agent_toolset_20260401");
  const config = toolset?.default_config;
  const policy = isRecord(config) ? config.permission_policy : undefined;
  const mode = isRecord(policy) ? policy.type : "always_allow";
  if (mode !== "always_ask" && mode !== "auto" && mode !== "always_allow") throw new Error("Invalid global ACP permission mode");
  return mode;
}
