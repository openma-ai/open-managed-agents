import {
  RemoteCodemodeSandbox,
  type CodemodeDeclaredTool,
  type CodemodeHostCall,
  type CodemodeOutcome,
  type CodemodeRemote,
  type CodemodeResult,
  type CodemodeRun,
  type CodemodeRunOptions,
  type CodemodeTool,
} from "@earendil-works/pi-codemode/portable";
import { renderDeclarations } from "@earendil-works/pi-codemode/declarations";
import { tool } from "ai";
import { z } from "zod";

export const CODEMODE_TOOL_NAME = "codemode";

export interface CodemodeRuntime {
  /** Remote QuickJS executor, normally a Durable Object in a separate Worker. */
  remote?: () => CodemodeRemote;
  /** Node/Bun hosts can provide a local QuickJS worker-thread sandbox here. */
  createSandbox?: (tools: CodemodeTool[]) => CodemodeSandboxLike;
  /** Interrupt budget requested from the remote QuickJS runtime. */
  interruptBudget?: number;
  /** Maximum time spent in the remote execution and nested tool calls. */
  timeoutMs?: number;
  /** Maximum QuickJS heap requested from the remote runtime. */
  memoryLimitBytes?: number;
  /** Durable checkpoint storage for an interrupted deterministic run. */
  checkpointStore?: CodemodeCheckpointStore;
  /** Namespaces checkpoints by the outer model tool-call id. */
  checkpointKey?: (toolCallId: string) => string;
}

export interface CodemodeSandboxLike {
  execute(code: string, options?: { signal?: AbortSignal }): Promise<CodemodeResult>;
  close(): Promise<void>;
  start?(code: string, options: CodemodeRunOptions): CodemodeRun;
}

export interface CodemodeCheckpoint {
  version: 1;
  code: string;
  startedAt: number;
  seed: number;
  fingerprint?: string;
  lastSeq: number;
  issued: number;
  store: Record<string, unknown>;
  outcomes: Record<string, {
    now: number;
    outcome: CodemodeOutcome;
  }>;
}

export interface CodemodeCheckpointStore {
  load(key: string): Promise<CodemodeCheckpoint | null>;
  save(key: string, checkpoint: CodemodeCheckpoint): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface CodemodeHostTool {
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  executionMode?: "parallel" | "sequential";
  execute?: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

interface ToolSchedulerJob<T> {
  mode: "parallel" | "sequential";
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Schedules a codemode script's nested calls without allowing a side-effecting
 * tool to overlap a parallel batch. Jobs before the first sequential job may
 * run together. Jobs after it wait until that sequential job finishes.
 */
class ToolScheduler {
  private readonly queue: ToolSchedulerJob<unknown>[] = [];
  private activeParallel = 0;
  private activeSequential = false;

  run<T>(mode: "parallel" | "sequential", run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ mode, run, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.activeSequential) return;
    const first = this.queue[0];
    if (!first) return;

    if (first.mode === "sequential") {
      if (this.activeParallel > 0) return;
      this.queue.shift();
      this.activeSequential = true;
      void first.run().then(first.resolve, first.reject).finally(() => {
        this.activeSequential = false;
        this.pump();
      });
      return;
    }

    while (this.queue[0]?.mode === "parallel") {
      const job = this.queue.shift();
      if (!job) break;
      this.activeParallel += 1;
      void job.run().then(job.resolve, job.reject).finally(() => {
        this.activeParallel -= 1;
        this.pump();
      });
    }
  }
}

const PARALLEL_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
]);

/** Resolve the default scheduling capability for the migrated Pi tool set. */
export function codemodeToolExecutionMode(name: string): "parallel" | "sequential" {
  return PARALLEL_TOOLS.has(name) ? "parallel" : "sequential";
}

function jsonSchemaOf(toolDefinition: CodemodeHostTool): Record<string, unknown> | undefined {
  const schema = toolDefinition.inputSchema ?? toolDefinition.parameters;
  if (!schema || typeof schema !== "object") return undefined;
  const candidate = schema as { jsonSchema?: unknown };
  if (candidate.jsonSchema && typeof candidate.jsonSchema === "object") {
    return candidate.jsonSchema as Record<string, unknown>;
  }
  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  } catch {
    return schema as Record<string, unknown>;
  }
}

function modelText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function nestedToolValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const candidate = value as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: unknown;
  };
  if (candidate.isError === true) {
    throw new Error(modelText(candidate.content) || "Nested tool execution failed");
  }
  if (candidate.structuredContent !== undefined) return candidate.structuredContent;
  if (!Array.isArray(candidate.content)) return value;
  return candidate.content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return modelText(part);
    })
    .join("\n");
}

function codemodeOutput(result: {
  ok: boolean;
  value?: unknown;
  output: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
  error?: { message: string; stack?: string };
}): string {
  const output = result.output.map((item) => {
    if (item.type === "text") return item.text ?? "";
    return `[image ${item.mimeType ?? "application/octet-stream"} ${item.data?.length ?? 0} base64 chars]`;
  });
  if (result.ok && result.value !== undefined) output.push(modelText(result.value));
  if (!result.ok) output.push(`Error: ${result.error?.stack ?? result.error?.message ?? "Code-mode execution failed"}`);
  return output.join("\n");
}

function checkpointBase(code: string, previous?: CodemodeCheckpoint | null): CodemodeCheckpoint {
  if (previous && previous.code === code) return previous;
  return {
    version: 1,
    code,
    startedAt: Date.now(),
    seed: (Math.random() * 0x1_0000_0000) >>> 0,
    lastSeq: 0,
    issued: 0,
    store: {},
    outcomes: {},
  };
}

function declaredTools(tools: readonly CodemodeTool[]): CodemodeDeclaredTool[] {
  return tools.map((entry) => ({
    name: entry.name,
    description: entry.description,
  }));
}

function outcomeFromValue(value: unknown): CodemodeOutcome {
  return { ok: true, value };
}

function outcomeFromError(error: unknown): CodemodeOutcome {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

async function executeResumable(
  sandbox: CodemodeSandboxLike,
  code: string,
  tools: readonly CodemodeTool[],
  signal: AbortSignal | undefined,
  checkpointStore: CodemodeCheckpointStore,
  checkpointKey: string,
): Promise<CodemodeResult> {
  if (!sandbox.start) {
    throw new Error("The configured QuickJS runtime does not support resumable execution");
  }
  const previous = await checkpointStore.load(checkpointKey);
  const checkpoint = checkpointBase(code, previous);
  let run: CodemodeRun | undefined;
  let checkpointWrite: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = structuredClone(checkpoint);
    checkpointWrite = checkpointWrite.then(() => checkpointStore.save(checkpointKey, snapshot));
    return checkpointWrite;
  };
  const deliver = (call: CodemodeHostCall, now: number, outcome: CodemodeOutcome): void => {
    const currentRun = run;
    if (!currentRun || currentRun.finished) return;
    try {
      currentRun.deliver(call.id, now, call.id, outcome);
    } catch {
      // A timeout or abort can finish the VM between the finished check and
      // delivery. The terminal result already carries that outcome.
    }
  };
  const onCall = (call: CodemodeHostCall) => {
    checkpoint.issued = Math.max(checkpoint.issued, call.id);
    void save().catch(() => undefined);
    const stored = checkpoint.outcomes[String(call.id)];
    if (stored) {
      queueMicrotask(() => deliver(call, stored.now, stored.outcome));
      return;
    }
    const tool = tools.find((entry) => entry.name === call.name);
    if (!tool) {
      queueMicrotask(() => deliver(call, Date.now(), {
        ok: false,
        message: `Unknown codemode tool ${call.name}`,
      }));
      return;
    }
    void Promise.resolve(tool.execute(call.args, { signal: signal ?? new AbortController().signal }))
      .then(outcomeFromValue, outcomeFromError)
      .then(async (outcome) => {
        const now = Date.now();
        checkpoint.outcomes[String(call.id)] = { now, outcome };
        checkpoint.lastSeq = Math.max(checkpoint.lastSeq, call.id);
        await save();
        deliver(call, now, outcome);
      })
      .catch((error: unknown) => {
        const currentRun = run;
        if (currentRun && !currentRun.finished) {
          try {
            currentRun.deliver(call.id, Date.now(), call.id, outcomeFromError(error));
          } catch {
            // The run may have finished while the checkpoint write was settling.
          }
        }
      });
  };
  run = sandbox.start(code, {
    startedAt: checkpoint.startedAt,
    seed: checkpoint.seed,
    tools: declaredTools(tools),
    store: checkpoint.store,
    signal,
    onStarted: (fingerprint) => {
      if (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) {
        // Deterministic replays are only valid on the same QuickJS/prelude/
        // resource-limit fingerprint. Start a fresh run if the runtime was
        // upgraded or its limits changed while the session was parked.
        checkpoint.startedAt = Date.now();
        checkpoint.seed = (Math.random() * 0x1_0000_0000) >>> 0;
        checkpoint.lastSeq = 0;
        checkpoint.issued = 0;
        checkpoint.store = {};
        checkpoint.outcomes = {};
      }
      checkpoint.fingerprint = fingerprint;
      void save().catch(() => undefined);
    },
    onCall,
    onIdle: (seq, issued) => {
      checkpoint.lastSeq = Math.max(checkpoint.lastSeq, seq);
      checkpoint.issued = Math.max(checkpoint.issued, issued);
      void save().catch(() => undefined);
    },
  });
  const result = await run.result;
  if (result.ok) {
    for (const key of result.storeWrites.delete) delete checkpoint.store[key];
    Object.assign(checkpoint.store, result.storeWrites.set);
    await checkpointWrite;
    await checkpointStore.clear(checkpointKey);
  } else if (result.error.kind === "script") {
    await checkpointWrite;
    await checkpointStore.clear(checkpointKey);
  } else {
    await save();
  }
  return result;
}

/**
 * Build the AI SDK tool used by the Pi harness. The VM itself lives behind the
 * supplied remote and every nested call crosses the same tool boundary as a
 * direct model call, including abort propagation and error reporting.
 */
export function createCodemodeTool(
  hostTools: Record<string, CodemodeHostTool>,
  runtime: CodemodeRuntime,
) {
  const hostToolEntries = Object.entries(hostTools)
    .filter(([name, definition]) => name !== CODEMODE_TOOL_NAME && typeof definition.execute === "function");
  const makeCodemodeTools = (scheduler: ToolScheduler): CodemodeTool[] => hostToolEntries.map(([name, definition]) => ({
      name,
      description: definition.description,
      inputSchema: jsonSchemaOf(definition),
      execute: (args: unknown, context: { signal: AbortSignal }) => scheduler.run(
        definition.executionMode ?? codemodeToolExecutionMode(name),
        async () => nestedToolValue(await definition.execute!(args, { abortSignal: context.signal })),
      ),
    }));
  const declarations = renderDeclarations({
    tools: hostToolEntries.map(([name, definition]) => ({
      name,
      description: definition.description,
      inputSchema: jsonSchemaOf(definition),
      execute: async () => undefined,
    })),
  });

  return tool({
    description:
      "Run JavaScript in an isolated QuickJS sandbox. Call tools with await tools.name(args), " +
      "use Promise.allSettled for independent calls, and use text(value) to emit output.\n\n" +
      declarations,
    inputSchema: z.object({
      code: z.string().min(1).describe("JavaScript code to run in the isolated QuickJS sandbox"),
    }),
    execute: async ({ code }, options) => {
      const scheduler = new ToolScheduler();
      const codemodeTools = makeCodemodeTools(scheduler);
      const sandbox = runtime.createSandbox
        ? runtime.createSandbox(codemodeTools)
        : runtime.remote
          ? new RemoteCodemodeSandbox({
              tools: codemodeTools,
              remote: runtime.remote,
              interruptBudget: runtime.interruptBudget,
              timeoutMs: runtime.timeoutMs,
              memoryLimitBytes: runtime.memoryLimitBytes,
            })
          : null;
      if (!sandbox) throw new Error("No QuickJS codemode runtime is configured");
      try {
        const checkpointStore = runtime.checkpointStore;
        const toolCallId = options?.toolCallId ?? "codemode";
        const result = checkpointStore
          ? await executeResumable(
              sandbox,
              code,
              codemodeTools,
              options?.abortSignal,
              checkpointStore,
              runtime.checkpointKey?.(toolCallId) ?? toolCallId,
            )
          : await sandbox.execute(code, { signal: options?.abortSignal });
        return codemodeOutput(result);
      } finally {
        await sandbox.close();
      }
    },
  });
}
