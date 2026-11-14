/**
 * A sandbox whose ACP agent answers initialize / session/new, starts a prompt,
 * then dies (exit 137) before replying. `stdoutEndsOnExit` is the platform's
 * stdio property: a Node pipe ends stdout with the process; Cloudflare's RPC
 * stdio can report the exit while stdout stays open
 * (e2e cf-container-acp-mm-r1, session_30b83e8f17f44e72a04e92393e8169f4).
 */
export interface DyingAcpAgentStdio {
  stdoutEndsOnExit: boolean;
  /** Cooperative deadline fixture: remain alive until session/cancel. */
  timeout?: boolean;
}

export const DYING_ACP_AGENT = { id: "parity-acp-agent", command: "parity-acp-agent", cwd: "/workspace" } as const;

export function dyingAcpAgentSandbox(stdio: DyingAcpAgentStdio) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    exec: async () => "",
    readFile: async (): Promise<string> => { throw new Error("absent"); },
    writeFile: async (path: string) => path,
    async spawnDuplexProcess() {
      let output!: ReadableStreamDefaultController<Uint8Array>;
      let exit!: (value: { code: number | null; signal: string | null }) => void;
      let gone = false;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve; });
      const die = (code: number | null) => {
        if (gone) return;
        gone = true;
        if (stdio.stdoutEndsOnExit) { try { output.close(); } catch { /* closed */ } }
        exit({ code, signal: null });
      };
      const send = (message: unknown) => output.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
      let buffered = "";
      let promptId: number | undefined;
      return {
        stdout: new ReadableStream<Uint8Array>({ start: (controller) => { output = controller; } }),
        stderr: new ReadableStream<Uint8Array>(),
        stdin: new WritableStream<Uint8Array>({
          write(chunk) {
            if (gone) throw new Error("stream is closed");
            buffered += decoder.decode(chunk);
            let index: number;
            while ((index = buffered.indexOf("\n")) >= 0) {
              const request = JSON.parse(buffered.slice(0, index)) as { id?: number; method: string };
              buffered = buffered.slice(index + 1);
              const result = (value: unknown) => send({ jsonrpc: "2.0", id: request.id, result: value });
              if (request.method === "initialize") result({ protocolVersion: 1, agentCapabilities: {} });
              else if (request.method === "session/new") result({ sessionId: "pi-session" });
              else if (request.method === "session/prompt") {
                send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "pi-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } } } });
                promptId = request.id;
                if (!stdio.timeout) setTimeout(() => die(137), 10);
              } else if (request.method === "session/cancel" && stdio.timeout) {
                send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
              } else if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
            }
          },
        }),
        exited,
        async kill() { die(null); },
      };
    },
  };
}
