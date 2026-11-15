import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  AcpStatefulAgentSpec,
} from "@open-managed-agents/acp-runtime/native-state";
import {
  captureAcpSandboxAgentState,
  hasRequiredAcpSandboxAgentState,
  materializeAcpSandboxAgentState,
  prepareAcpSandboxAgent,
  releaseAcpSandboxAgentState,
  restoreAcpSandboxAgentState,
  type AcpSandboxAgentPreparation,
  type AcpSandboxAgentStatePort,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import { randomUUID } from "node:crypto";
import { buildManagedEventRecoveryPrompt, type ManagedRecoveryEvent } from "./semantic-recovery.js";
import type { AcpSession, AcpRuntime, SessionOptions } from "@open-managed-agents/acp-runtime";
import type {
  SessionHostEvent,
  SessionStartCommand,
} from "@openma/common/session-kernel";

import type {
  ManagedHarnessSessionStartCommand,
  ManagedHarnessSessionStatePort,
  ManagedHarnessSessionStatePreparation,
} from "./index.js";

export interface NodeAcpHarnessStateIo extends AcpSandboxAgentStatePort {
  readFile(path: string): Promise<string>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
}

export interface NodeAcpHarnessStateIoOptions {
  /** Actual path mounted at the protocol-level `/workspace`. */
  workspacePath?: string;
}

/** Node filesystem/process adapter used from inside Docker, MicroVMs and
 * other Node-capable sandbox images. It contains no durable-store logic. */
export function createNodeAcpHarnessStateIo(
  options: NodeAcpHarnessStateIoOptions = {},
): NodeAcpHarnessStateIo {
  const workspacePath = options.workspacePath ?? "/workspace";
  const resolveProtocolPath = (path: string): string => {
    if (path === "/workspace") return workspacePath;
    if (path.startsWith("/workspace/")) {
      return join(workspacePath, path.slice("/workspace/".length));
    }
    return path;
  };
  return {
    async readFile(path) {
      return readFile(resolveProtocolPath(path), "utf8");
    },
    async writeFile(path, content) {
      const resolved = resolveProtocolPath(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    async writeFileBytes(path, content) {
      const resolved = resolveProtocolPath(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    async exec(command) {
      const result = await promisify(execFile)("/bin/sh", ["-c", command], {
        cwd: workspacePath,
        maxBuffer: 16 * 1024 * 1024,
      });
      return result.stdout;
    },
  };
}

export interface AcpHarnessResolvedSession {
  agent: AcpStatefulAgentSpec;
  restart?: SessionOptions["restart"];
  clientCallbacks?: SessionOptions["clientCallbacks"];
  idleTimeoutMs?: number;
  perTurnTimeoutMs?: number;
  mcpServers?: SessionOptions["mcpServers"];
  additionalDirectories?: string[];
  sessionRequestMeta?: Record<string, unknown>;
}

export interface AcpNativeSessionStateOptions {
  io: NodeAcpHarnessStateIo;
  /** Exact installed harness identity; changing it requires a new Session. */
  harness?: { id: string; version: string; digest?: string };
  resolveSession(
    command: SessionStartCommand,
  ): Promise<AcpHarnessResolvedSession>;
}

interface NativeStateRecord {
  preparation: AcpSandboxAgentPreparation;
  options: AcpHarnessResolvedSession;
  resumeAcpSessionId?: string;
  lastCompletedTurnId?: string;
}

interface NativeCheckpointV1 {
  version: 1;
  harness?: { id: string; version: string; digest?: string };
  adapter_id: string;
  acp_session_id: string;
  last_completed_turn_id?: string;
}

/**
 * OpenMA-owned native Session persistence for a whole-brain ACP runtime.
 *
 * Harbor informs only `prepareAcpSandboxAgent()`'s per-agent artifact list.
 * This object owns restore timing, checkpoint creation, stale-resume rejection
 * and deletion semantics and is intentionally independent of any provider SDK.
 */
export class AcpNativeSessionState implements ManagedHarnessSessionStatePort {
  readonly #records = new Map<string, NativeStateRecord>();

  constructor(private readonly options: AcpNativeSessionStateOptions) {}

  async beforeStart(
    command: ManagedHarnessSessionStartCommand,
  ): Promise<ManagedHarnessSessionStatePreparation> {
    const { canonicalCompletedTurnId, ...sessionCommand } = command;
    const resolved = await this.options.resolveSession(sessionCommand);
    const preparation = prepareAcpSandboxAgent({
      sessionId: sessionCommand.sessionId,
      agent: resolved.agent,
    });
    await materializeAcpSandboxAgentState(this.options.io, preparation);
    const checkpoint = await this.#readCheckpoint(preparation);
    if (checkpoint !== null && (
      checkpoint.harness?.id !== this.options.harness?.id
      || checkpoint.harness?.version !== this.options.harness?.version
      || checkpoint.harness?.digest !== this.options.harness?.digest
    )) {
      throw new Error("Native checkpoint harness version does not match the selected harness; create a new Session");
    }
    const resumeAcpSessionId = checkpoint?.acp_session_id
      ?? sessionCommand.acpSessionId;
    let semanticRecoveryReason: ManagedHarnessSessionStatePreparation["semanticRecoveryReason"];
    let usableResumeId = resumeAcpSessionId;
    if (canonicalCompletedTurnId !== undefined
      && checkpoint?.last_completed_turn_id !== canonicalCompletedTurnId) {
      usableResumeId = undefined;
      semanticRecoveryReason = "native-state-stale";
    } else if (
      resumeAcpSessionId !== undefined
      && preparation.binding.resume === "native-and-acp"
    ) {
      if (await hasRequiredAcpSandboxAgentState(this.options.io, preparation)) {
        await restoreAcpSandboxAgentState(this.options.io, preparation);
      } else {
        usableResumeId = undefined;
        semanticRecoveryReason = "native-state-missing";
      }
    }
    this.#records.set(sessionCommand.sessionId, {
      preparation,
      options: resolved,
      ...(checkpoint?.last_completed_turn_id === undefined
        ? {}
        : { lastCompletedTurnId: checkpoint.last_completed_turn_id }),
      ...(usableResumeId === undefined
        ? {}
        : { resumeAcpSessionId: usableResumeId }),
    });
    const preparedCommand: SessionStartCommand = usableResumeId === undefined
      ? (resumeAcpSessionId === undefined
        ? sessionCommand
        : { ...sessionCommand, acpSessionId: undefined })
      : { ...sessionCommand, acpSessionId: usableResumeId };
    return {
      command: preparedCommand,
      ...(semanticRecoveryReason === undefined ? {} : { semanticRecoveryReason }),
    };
  }

  async prepare(command: SessionStartCommand): Promise<SessionOptions> {
    const record = this.#records.get(command.sessionId);
    if (record === undefined) {
      throw new Error(
        `ACP native state for ${command.sessionId} was not prepared before start`,
      );
    }
    const resolved = record.options;
    return {
      agent: record.preparation.launch,
      ...(resolved.clientCallbacks === undefined ? {} : { clientCallbacks: resolved.clientCallbacks }),
      ...(resolved.restart === undefined ? {} : { restart: resolved.restart }),
      ...(resolved.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: resolved.idleTimeoutMs }),
      ...(resolved.perTurnTimeoutMs === undefined
        ? {}
        : { perTurnTimeoutMs: resolved.perTurnTimeoutMs }),
      ...(resolved.mcpServers === undefined ? {} : { mcpServers: resolved.mcpServers }),
      ...(resolved.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: resolved.additionalDirectories }),
      ...(resolved.sessionRequestMeta === undefined
        ? {}
        : { sessionRequestMeta: resolved.sessionRequestMeta }),
      ...(command.acpSessionId === undefined
        ? {}
        : { resumeAcpSessionId: command.acpSessionId }),
    };
  }

  async hasRuntimeState(sessionId: string): Promise<boolean> {
    const record = this.#requireRecord(sessionId);
    if (record.preparation.binding.resume !== "native-and-acp") return true;
    return hasRequiredAcpSandboxAgentState(this.options.io, {
      ...record.preparation,
      binding: {
        ...record.preparation.binding,
        sessionArtifacts: record.preparation.binding.sessionArtifacts.map(artifact => ({
          ...artifact, path: artifact.runtimePath,
        })),
      },
    });
  }

  async onReady(
    event: Extract<SessionHostEvent, { type: "session.ready" }>,
  ): Promise<void> {
    const record = this.#requireRecord(event.sessionId);
    const checkpoint: NativeCheckpointV1 = {
      version: 1,
      ...(this.options.harness === undefined ? {} : { harness: this.options.harness }),
      adapter_id: record.preparation.binding.adapterId,
      acp_session_id: event.acpSessionId,
      ...(record.lastCompletedTurnId === undefined
        ? {}
        : { last_completed_turn_id: record.lastCompletedTurnId }),
    };
    await this.options.io.writeFile(
      record.preparation.binding.checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
    );
    record.resumeAcpSessionId = event.acpSessionId;
  }

  async checkpoint(input: { sessionId: string; turnId?: string }): Promise<void> {
    const record = this.#requireRecord(input.sessionId);
    if (record.resumeAcpSessionId === undefined) {
      throw new Error(`ACP native state for ${input.sessionId} is not ready`);
    }
    if (input.turnId !== undefined) record.lastCompletedTurnId = input.turnId;
    const checkpoint: NativeCheckpointV1 = {
      version: 1,
      ...(this.options.harness === undefined ? {} : { harness: this.options.harness }),
      adapter_id: record.preparation.binding.adapterId,
      acp_session_id: record.resumeAcpSessionId,
      ...(record.lastCompletedTurnId === undefined
        ? {}
        : { last_completed_turn_id: record.lastCompletedTurnId }),
    };
    // The marker is advanced before copying artifacts. If capture crashes,
    // canonical history still has the older watermark and recovery rejects
    // this candidate. Publication happens only after capture succeeds.
    await this.options.io.writeFile(
      record.preparation.binding.checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
    );
    await captureAcpSandboxAgentState(this.options.io, record.preparation);
  }

  async release(input: {
    sessionId: string;
    reason: "shutdown" | "destroy";
  }): Promise<void> {
    const record = this.#requireRecord(input.sessionId);
    await releaseAcpSandboxAgentState(
      this.options.io,
      record.preparation,
      input.reason === "destroy" ? "destroy" : "shutdown",
    );
    this.#records.delete(input.sessionId);
  }

  async #readCheckpoint(
    preparation: AcpSandboxAgentPreparation,
  ): Promise<NativeCheckpointV1 | null> {
    try {
      const value = JSON.parse(
        await this.options.io.readFile(preparation.binding.checkpointPath),
      ) as Partial<NativeCheckpointV1>;
      if (
        value.version !== 1
        || value.adapter_id !== preparation.binding.adapterId
        || typeof value.acp_session_id !== "string"
        || value.acp_session_id.length === 0
        || (value.last_completed_turn_id !== undefined
          && (typeof value.last_completed_turn_id !== "string"
            || value.last_completed_turn_id.length === 0))
      ) return null;
      return value as NativeCheckpointV1;
    } catch {
      return null;
    }
  }

  #requireRecord(sessionId: string): NativeStateRecord {
    const record = this.#records.get(sessionId);
    if (record === undefined) {
      throw new Error(`ACP native state for ${sessionId} is not active`);
    }
    return record;
  }
}

export function createAcpNativeSessionState(
  options: AcpNativeSessionStateOptions,
): AcpNativeSessionState {
  return new AcpNativeSessionState(options);
}

/** Resident consumers check the native allowlist between canonical roots, not
 * between continuation/revision prompts. A missing allowlist closes the actual
 * old process and starts a fresh session before permission verification/consume.
 * The stable proxy lets the common host keep its dispatch identity; it does not
 * invent a native session or replay any input. */
export function createRecoverableNativeSession(options: {
  session: AcpSession;
  sessionOptions: SessionOptions;
  runtime: AcpRuntime;
  state: AcpNativeSessionState;
  sessionId(): string;
  nativeReady(session: AcpSession): void;
  instructions(): string;
  history(): Promise<readonly ManagedRecoveryEvent[]>;
  maxCharacters?: number;
}): {session: AcpSession; beforeRootPrompt(): Promise<void>} {
  let session = options.session;
  let firstPrompt = true;
  let completedPrompt = false;
  let recover = false;
  const wrapped = new Proxy(session, {get(_target, property) {
    if (property === "prompt") return async function*(...args: Parameters<AcpSession["prompt"]>) {
      let text = args[0];
      const platform = firstPrompt && options.instructions()
        ? `<openma-platform>\n${options.instructions()}\n</openma-platform>\n\n` : "";
      if (recover) {
        if (typeof text !== "string") throw new Error("Native recovery requires canonical text input");
        // Never deduplicate canonical history by the current request's text:
        // a prior, completed input can legitimately have identical wording.
        const placeholder = `current-${randomUUID()}`;
        const maximum = Math.max(1024, options.maxCharacters ?? 32000);
        const template = buildManagedEventRecoveryPrompt(await options.history(), placeholder, {
          reason: "native-state-missing", maxCharacters: maximum,
        });
        const historyStart = template.indexOf("Recovered conversation:\n") + "Recovered conversation:\n".length;
        const currentStart = template.lastIndexOf(`\nCurrent request:\n${placeholder}\n</openma-recovery>`);
        if (currentStart < historyStart) throw new Error("Invalid native recovery envelope");
        const prefix = template.slice(0, historyStart);
        const closing = "\n</openma-recovery>";
        const label = "\nCurrent request:\n";
        const payloadBudget = maximum - platform.length - prefix.length - label.length - closing.length;
        if (payloadBudget < 256) throw new Error("Platform context exceeds native recovery budget");
        const currentBudget = Math.floor(payloadBudget * 0.6);
        const marker = "\n… [current request truncated] …\n";
        const available = Math.max(0, currentBudget - marker.length);
        const current = text.length <= currentBudget ? text
          : text.slice(0, Math.ceil(available / 2)) + marker + text.slice(text.length - Math.floor(available / 2));
        let history = template.slice(historyStart, currentStart);
        const historyBudget = payloadBudget - current.length;
        if (history.length > historyBudget) {
          const omitted = "… earlier history omitted …\n";
          history = omitted + history.slice(-(historyBudget - omitted.length));
        }
        text = prefix + history + label + current + closing;
        recover = false;
      }
      if (platform && typeof text === "string") text = platform + text;
      firstPrompt = false;
      for await (const event of session.prompt(text,args[1])) yield event;
      completedPrompt = true;
    };
    const value = Reflect.get(session,property,session);
    return typeof value === "function" ? value.bind(session) : value;
  }});
  return {
    session: wrapped,
    async beforeRootPrompt() {
      if (!completedPrompt || await options.state.hasRuntimeState(options.sessionId())) return;
      await session.dispose();
      session = await options.runtime.start({...options.sessionOptions,resumeAcpSessionId:undefined});
      options.nativeReady(wrapped);
      await options.state.onReady({type:"session.ready",sessionId:options.sessionId(),acpSessionId:session.acpSessionId});
      recover = true;
      firstPrompt = true;
    },
  };
}
