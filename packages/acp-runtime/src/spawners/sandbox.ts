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

/** How long stdout may keep delivering after the process exit is reported.
 * Bytes the agent wrote before it exited still arrive through the bridge. */
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
  let stderr = process.stderr;
  if (onDiagnosticLine !== undefined) {
    const branches = stderr.tee();
    stderr = branches[0];
    void consumeDiagnosticLines(branches[1], onDiagnosticLine);
  }
  return {
    stdin: process.stdin,
    stdout: endingWithProcess(process.stdout, process.exited),
    stderr,
    exited: process.exited,
    kill: (signal) => process.kill(signal),
  };
}

/** A child's stdout ends when the child does: the ACP engine learns that the
 * agent is gone only from stdout EOF (Node pipes guarantee it). A sandbox
 * stdio bridge can report the exit while its stdout stays open (Cloudflare
 * RPC stdio, e2e cf-container-acp-mm-r1: pi-acp exited mid-turn and the turn
 * waited forever), so after the drain window the stream ends here and the
 * engine fails the turn as it does on Node. */
function endingWithProcess(
  stdout: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
): ReadableStream<Uint8Array> {
  const reader = stdout.getReader();
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (controller: ReadableStreamDefaultController<Uint8Array>, error?: unknown) => {
    if (ended) return;
    ended = true;
    if (timer !== undefined) clearTimeout(timer);
    if (error === undefined) controller.close();
    else controller.error(error);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void exited.then(() => undefined, () => undefined).then(() => {
        if (ended) return;
        timer = setTimeout(() => {
          end(controller);
          void reader.cancel().catch(() => undefined);
        }, STDOUT_DRAIN_AFTER_EXIT_MS);
      });
    },
    async pull(controller) {
      let item: Awaited<ReturnType<typeof reader.read>>;
      try {
        item = await reader.read();
      } catch (error) {
        end(controller, error);
        return;
      }
      if (ended) return;
      if (item.done) end(controller);
      else controller.enqueue(item.value);
    },
    cancel(reason) {
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      return reader.cancel(reason);
    },
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
