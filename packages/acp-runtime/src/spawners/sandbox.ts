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
    stdout: process.stdout,
    stderr,
    exited: process.exited,
    kill: (signal) => process.kill(signal),
  };
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
