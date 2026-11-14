import type { Spawner } from "@open-managed-agents/acp-runtime";
export class WorkVerifierExitUnconfirmedError extends Error { override readonly name = "WorkVerifierExitUnconfirmedError"; }
export type WorkVerifierExec = (command: string, options: { timeoutMs?: number } | undefined, signal: AbortSignal) => Promise<{ exit_code: number; output: string }>;

/** Product sandbox exec, using the SAME trusted placement as ACP (including
 * E2B isolation). Script bytes go over stdin, never an import/module path. */
export function createWorkVerifierExec(spawner: Spawner, workspacePath: string): WorkVerifierExec {
  return async (command, options, signal) => {
    signal.throwIfAborted();
    const timeout = options?.timeoutMs ?? 600_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) throw new Error("Invalid verifier timeout");
    // NodeSpawner merges process.env. Explicitly unset every inherited entry,
    // then supply only non-secret operational defaults. Do not read values.
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    Object.assign(env, { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workspacePath, LANG: "C.UTF-8" });
    const child = await spawner.spawn({ command: "/bin/sh", args: ["-s"], cwd: workspacePath, env });
    let output = "", failure: unknown;
    let stop: Promise<void> | undefined;
    let rejectUnconfirmed!: (error: Error) => void;
    const unconfirmed = new Promise<never>((_,reject)=>{rejectUnconfirmed=reject;});
    void unconfirmed.catch(()=>undefined);
    let exitDeadline: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: unknown) => {
      failure ??= error;
      if (!stop) {
        stop = child.kill("SIGKILL");
        exitDeadline = setTimeout(()=>rejectUnconfirmed(new WorkVerifierExitUnconfirmedError("Rule verifier exit unconfirmed after SIGKILL")),2000);
      }
      void stop.catch(() => undefined);
    };
    const abort = () => terminate(signal.reason ?? new DOMException("Verifier interrupted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => terminate(new Error("Rule verifier timed out")), timeout);
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(), decoder = new TextDecoder();
      try {
        while (true) {
          const item = await reader.read(); if (item.done) break;
          output += decoder.decode(item.value, { stream: true });
          if (output.length > 1_048_576) { terminate(new Error("Rule verifier output limit exceeded")); output = output.slice(-1_048_576); }
        }
        output += decoder.decode();
      } finally { reader.releaseLock(); }
    };
    const streams = Promise.all([collect(child.stdout), collect(child.stderr)]);
    void streams.catch(() => undefined);
    try {
      const writer = child.stdin.getWriter();
      try { await Promise.race([writer.write(new TextEncoder().encode(command+"\n")),unconfirmed]); await Promise.race([writer.close(),unconfirmed]); }
      catch (error) { terminate(error); }
      finally { writer.releaseLock(); }
      const [exit] = await Promise.race([Promise.all([child.exited, streams]),unconfirmed]);
      if (stop) await stop;
      if (failure) throw failure;
      signal.throwIfAborted();
      if (exit.code === null) throw new Error("Rule verifier exit unconfirmed");
      return { exit_code: exit.code, output };
    } finally { if(exitDeadline)clearTimeout(exitDeadline); clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
}
