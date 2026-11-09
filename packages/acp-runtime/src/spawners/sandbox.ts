import { SandboxGoneError } from "@open-managed-agents/sandbox";
import type {
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
} from "@open-managed-agents/sandbox";
import type {
  AgentSpec,
  ChildHandle,
  Spawner,
} from "@openma/common/acp-runtime";

/** Raised when a sandbox backend can execute commands but cannot keep a live
 * bidirectional stdio channel. ACP is a process protocol, so falling back to
 * log polling would silently corrupt its request/response semantics. */
export class SandboxAcpUnsupportedError extends Error {
  constructor() {
    super("sandbox does not support duplex processes required by ACP");
    this.name = "SandboxAcpUnsupportedError";
  }
}

export class SandboxAcpTransportError extends Error {
  override readonly name = "SandboxAcpTransportError";
  constructor(readonly channel: "stdout" | "stderr") {
    super(`ACP transport failed: ${channel} drain was not confirmed after process exit; output may be incomplete. Restart the agent and inspect the sandbox transport.`);
  }
}
const transportErrors = new WeakMap<ChildHandle, SandboxAcpTransportError | SandboxGoneError>();
export function sandboxAcpTransportError(child: ChildHandle): SandboxAcpTransportError | SandboxGoneError | undefined {
  return transportErrors.get(child);
}

/** Silence allowed on a pending output read after exit (not a total drain
 * deadline). Backpressure and already-buffered bytes never start this clock. */
export const STDOUT_DRAIN_AFTER_EXIT_MS = 2_000;

/** Host-neutral ACP spawner. Local, Cloudflare, E2B, and future sandbox
 * adapters all converge on SandboxDuplexProcessPort; the shared ACP
 * runtime above this class owns exactly one session/event loop. */
export class SandboxSpawner implements Spawner {
  constructor(private readonly sandbox: SandboxDuplexProcessPort) {}

  async spawn(spec: AgentSpec): Promise<ChildHandle> {
    if (this.sandbox.spawnDuplexProcess === undefined) {
      throw new SandboxAcpUnsupportedError();
    }
    const process = await this.sandbox.spawnDuplexProcess({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
    });
    return toChildHandle(process, spec.onDiagnosticLine);
  }
}

function toChildHandle(
  process: SandboxDuplexProcess,
  onDiagnosticLine?: (line: string) => void,
): ChildHandle {
  const stops: Array<(error: Error) => void> = [];
  const observedExit = process.exited.catch(async error => {
    const gone = await process.confirmSandboxGone?.().catch(() => false);
    if (!gone) throw error;
    const lost = new SandboxGoneError("Provider confirmed the ACP sandbox is gone");
    transportErrors.set(handle, lost);
    for (const stop of stops) stop(lost);
    throw lost;
  });
  void observedExit.catch(() => undefined);
  const observation = {
    event: "acp.process_exit_stdio", clock: "unix_ms", byteTiming: "consumer_read", observationWindowMs: STDOUT_DRAIN_AFTER_EXIT_MS * 2, processId: crypto.randomUUID(), exitAtMs: null as number | null,
    stdout: { lastByteAtMs: null as number | null, eofAtMs: null as number | null, timedOutAtMs: null as number | null, outcome: "pending" },
    stderr: { lastByteAtMs: null as number | null, eofAtMs: null as number | null, timedOutAtMs: null as number | null, outcome: "pending" },
  };
  let reported = false;
  let reportTimer: ReturnType<typeof setTimeout> | undefined;
  const report = () => {
    if (reported || observation.exitAtMs === null) return;
    reported = true;
    if (reportTimer !== undefined) clearTimeout(reportTimer);
    console.info(JSON.stringify(observation));
  };
  const observe = (channel: "stdout" | "stderr", kind: "byte" | "eof" | "timed_out" | "error" | "cancelled") => {
    const stream = observation[channel];
    if (kind === "byte") stream.lastByteAtMs = Date.now();
    else { stream.outcome = kind; if (kind === "eof") stream.eofAtMs = Date.now(); if (kind === "timed_out") stream.timedOutAtMs = Date.now(); }
    if (observation.stdout.outcome !== "pending" && observation.stderr.outcome !== "pending") report();
  };
  void observedExit.then(() => undefined, () => undefined).then(() => {
    observation.exitAtMs = Date.now();
    if (observation.stdout.outcome !== "pending" && observation.stderr.outcome !== "pending") report();
    else reportTimer = setTimeout(() => {
      for (const channel of ["stdout", "stderr"] as const) {
        if (observation[channel].outcome === "pending") { observation[channel].outcome = "timed_out"; observation[channel].timedOutAtMs = Date.now(); }
      }
      report();
    }, STDOUT_DRAIN_AFTER_EXIT_MS * 2);
    (reportTimer as unknown as { unref?: () => void } | undefined)?.unref?.();
  });
  let handle: ChildHandle;
  const onTransportError = (error: SandboxAcpTransportError) => { if (error.channel === "stdout") transportErrors.set(handle, error); };
  let stderr = endingWithProcess(process.stderr, observedExit, "stderr", onTransportError, observe, stops);
  if (onDiagnosticLine !== undefined) {
    const branches = stderr.tee();
    stderr = branches[0];
    void consumeDiagnosticLines(branches[1], onDiagnosticLine).catch(() => undefined);
  }
  handle = {
    stdin: inputEndingWithProcess(process.stdin, observedExit),
    stdout: endingWithProcess(process.stdout, observedExit, "stdout", onTransportError, observe, stops),
    stderr,
    exited: observedExit,
    kill: (signal) => process.kill(signal),
  };
  return handle;
}

/** Exit is not transport EOF. Read only on demand, preserving backpressure.
 * A bridge that never sends EOF is cancelled only after a pending source read
 * has seen no bytes for the quiet period following exit. Every delivered chunk
 * clears that timer; slow consumers may drain arbitrarily long. Packets arriving
 * after a full quiet period cannot be distinguished from a dead bridge, so
 * expiry is an explicit transport error, never evidence of normal EOF. */
function endingWithProcess(
  source: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
  channel: "stdout" | "stderr",
  onTransportError: (error: SandboxAcpTransportError) => void,
  observe: (channel: "stdout" | "stderr", kind: "byte" | "eof" | "timed_out" | "error" | "cancelled") => void,
  stops: Array<(error: Error) => void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  let terminalError: Error | undefined;
  let hasExited = false;
  let pending: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  stops.push(error => {
    ended = true; terminalError = error; clearTimer();
    pending?.error(error); pending = undefined;
    void reader.cancel(error).catch(() => undefined);
  });
  const arm = () => {
    if (!hasExited || pending === undefined || ended) return;
    timer = setTimeout(() => {
      if (ended || pending === undefined) return;
      ended = true;
      const error = new SandboxAcpTransportError(channel);
      observe(channel, "timed_out");
      onTransportError(error);
      pending.error(error);
      pending = undefined;
      void reader.cancel().catch(() => undefined);
    }, STDOUT_DRAIN_AFTER_EXIT_MS);
  };
  void exited.then(() => undefined, () => undefined).then(() => {
    hasExited = true;
    arm();
  });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminalError) { controller.error(terminalError); return; }
      pending = controller;
      arm();
      try {
        const item = await reader.read();
        clearTimer();
        pending = undefined;
        if (ended) return;
        if (item.done) { ended = true; observe(channel, "eof"); controller.close(); }
        else { if (item.value.byteLength > 0) observe(channel, "byte"); controller.enqueue(item.value); }
      } catch (error) {
        clearTimer();
        pending = undefined;
        if (!ended) { ended = true; observe(channel, "error"); controller.error(error); }
      }
    },
    cancel(reason) {
      observe(channel, "cancelled");
      ended = true;
      pending = undefined;
      clearTimer();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/** Own the writer so an exit can terminate even a locked or blocked stdin.
 * Abort is best effort at the transport; the exposed writer ends immediately. */
function inputEndingWithProcess(
  source: WritableStream<Uint8Array>,
  exited: Promise<unknown>,
): WritableStream<Uint8Array> {
  const writer = source.getWriter();
  const error = new Error("agent process exited; stdin is closed");
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  return new WritableStream<Uint8Array>({
    start(controller) {
      void exited.then(() => undefined, () => undefined).then(() => {
        controller.error(error);
        stop();
        void writer.abort(error).catch(() => undefined);
      });
      void writer.closed.catch(reason => { controller.error(reason); stop(); });
    },
    write(chunk) {
      return Promise.race([writer.write(chunk), stopped.then(() => { throw error; })]);
    },
    close: () => Promise.race([writer.close(), stopped.then(() => { throw error; })]),
    abort: reason => writer.abort(reason),
  });
}

async function consumeDiagnosticLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      buffered += decoder.decode(item.value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } finally {
    buffered += decoder.decode();
    if (buffered.length > 0) onLine(buffered);
    reader.releaseLock();
  }
}
