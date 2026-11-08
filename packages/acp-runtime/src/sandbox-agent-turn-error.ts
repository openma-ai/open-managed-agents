import type { AcpSandboxAgentPreparation, AcpSandboxAgentStatePort } from "./sandbox-agent.js";

/**
 * The error of a turn the ACP agent ended without output, read from the
 * agent's own transcript; null when the agent keeps none we can read or the
 * last turn did not fail.
 *
 * pi-acp 0.0.33 answers a failed pi turn (no model, upstream 401, ...) with
 * stopReason `end_turn` and no update carrying the error; pi records it on
 * the turn's assistant message in its session JSONL (`stopReason: "error"`,
 * `errorMessage`, pi docs/session-format.md).
 */
export async function readAcpSandboxAgentTurnError(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<string | null> {
  if (preparation.binding.adapterId !== "pi") return null;
  const sessions = `${preparation.binding.nativePath}/home/.pi/agent/sessions`;
  const output = await sandbox.exec(
    `latest=$(ls -t -- ${shellQuote(sessions)}/*/*.jsonl 2>/dev/null | head -n 1); if [ -n "$latest" ]; then tail -n 20 -- "$latest"; fi`,
  );
  for (const line of output.split("\n").reverse()) {
    let entry: { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    return entry.message.stopReason === "error"
      ? (typeof entry.message.errorMessage === "string" && entry.message.errorMessage) || "pi reported an error without a message"
      : null;
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
