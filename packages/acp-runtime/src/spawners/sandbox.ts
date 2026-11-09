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
  let stderr = endingWithProcess(process.stderr, process.exited);
  if (onDiagnosticLine !== undefined) {
    const branches = stderr.tee();
    stderr = branches[0];
    void consumeDiagnosticLines(branches[1], onDiagnosticLine).catch(() => undefined);
  }
  return {
    stdin: inputEndingWithProcess(process.stdin, process.exited),
    stdout: endingWithProcess(process.stdout, process.exited),
    stderr,
    exited: process.exited,
    kill: (signal) => process.kill(signal),
  };
}

/** Exit is not transport EOF. Read only on demand, preserving backpressure.
 * A bridge that never sends EOF is cancelled only after a pending source read
 * has seen no bytes for the quiet period following exit. Every delivered chunk
 * clears that timer; slow consumers may drain arbitrarily long. Packets arriving
 * after a full quiet period cannot be distinguished from a dead bridge. */
function endingWithProcess(
  source: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  let hasExited = false;
  let pending: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    if (!hasExited || pending === undefined || ended) return;
    timer = setTimeout(() => {
      if (ended || pending === undefined) return;
      ended = true;
      pending.close();
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
      pending = controller;
      arm();
      try {
        const item = await reader.read();
        clearTimer();
        pending = undefined;
        if (ended) return;
        if (item.done) { ended = true; controller.close(); }
        else controller.enqueue(item.value);
      } catch (error) {
        clearTimer();
        pending = undefined;
        if (!ended) { ended = true; controller.error(error); }
      }
    },
    cancel(reason) {
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
    close: () => writer.close(),
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
    buffered += decoder.decode();
    if (buffered.length > 0) onLine(buffered);
  } finally {
    reader.releaseLock();
  }
}
