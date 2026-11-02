// Shared by agent create/update. Only explicitly supplied update fields are sent.
export function parseAgentWrite(args: string[], update: boolean) {
  const values = new Map<string, string>();
  const refs: string[] = [];
  const positional: string[] = [];
  let inlineOnly = false;
  const valueFlags = new Set(["--name", "--model", "--system", "--runtime", "--acp-agent", "--multiagent", "--subagent"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--inline-only") {
      if (inlineOnly) throw new Error("Duplicate --inline-only");
      inlineOnly = true;
    } else if (valueFlags.has(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--") || (value === "" && arg !== "--system")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--subagent") refs.push(value);
      else {
        if (values.has(arg)) throw new Error(`Duplicate ${arg}`);
        values.set(arg, value);
      }
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1 || (!update && positional.length && values.has("--name"))) {
    throw new Error("Supply exactly one agent name or ID");
  }
  const target = update ? positional[0] : values.get("--name") ?? positional[0];
  if (!target?.trim()) throw new Error(update ? "Agent ID is required" : "Agent name is required");
  const body: Record<string, unknown> = update ? {} : {
    name: target, model: "claude-sonnet-4-6", system: "", tools: [{ type: "agent_toolset_20260401" }],
  };
  for (const field of ["name", "model", "system"]) {
    if (values.has(`--${field}`)) body[field] = values.get(`--${field}`);
  }
  const runtimeId = values.get("--runtime");
  const acpAgentId = values.get("--acp-agent");
  if (!!runtimeId !== !!acpAgentId) throw new Error("--runtime and --acp-agent must be supplied together");
  if (runtimeId && acpAgentId) body._oma = {
    harness: "acp-proxy", runtime_binding: { runtime_id: runtimeId, acp_agent_id: acpAgentId },
  };
  if (inlineOnly && refs.length) throw new Error("--inline-only cannot be combined with --subagent");
  if (values.has("--multiagent")) {
    if (inlineOnly || refs.length) throw new Error("--multiagent cannot be combined with --inline-only or --subagent");
    let multiagent: unknown;
    try { multiagent = JSON.parse(values.get("--multiagent")!); }
    catch { throw new Error("--multiagent requires valid JSON"); }
    if (multiagent !== null && (typeof multiagent !== "object" || Array.isArray(multiagent)
      || (multiagent as { type?: unknown }).type !== "multiagent_20261001")) {
      throw new Error('--multiagent must be null or an object with type "multiagent_20261001"');
    }
    // Preserve omitted fields, explicit nulls and reference forms; the API
    // validates the full contract and reports unsupported capabilities.
    body.multiagent = multiagent;
  } else if (inlineOnly || refs.length) {
    const predefined_agents = refs.map(ref => {
      const [id, versionText, ...extra] = ref.split(":");
      if (!id || extra.length || (versionText !== undefined && (!/^\d+$/u.test(versionText)
        || !Number.isSafeInteger(Number(versionText)) || Number(versionText) < 1))) {
        throw new Error(`Invalid --subagent value ${ref}; expected <agent-id>[:positive-version]`);
      }
      return { type: "agent", id, ...(versionText !== undefined && { version: Number(versionText) }) };
    });
    body.multiagent = {
      type: "multiagent_20261001", advisor: { type: "disabled" },
      subagents: { type: "enabled", inline_agents: { type: inlineOnly ? "enabled" : "disabled" }, predefined_agents },
      workflows: { type: "disabled" },
    };
  }
  if (update && !Object.keys(body).length) throw new Error("Supply at least one field to update");
  return { target, body, runtimeId, acpAgentId };
}
