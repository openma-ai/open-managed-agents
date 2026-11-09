/** Evidence is structural only: never retain arbitrary upstream strings. */
const fields = new Set(["id", "type", "status", "role", "turn_id", "call_id", "subagent_id", "parent_agent_id", "event_id", "name", "data", "items", "turns", "required_actions", "scenario", "results", "head", "sourceSha256", "diffSha256", "deployedHead", "startedAt", "at", "method", "httpStatus", "provider", "model", "model_id", "expectedWireModel", "size_bytes", "exit_code", "code", "error", "output", "content", "text"]);
export function structuralEvidence(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(?:sk[-_]|oma_sbx_|Bearer |gh[pousr]_)/i.test(value)) return "<redacted>";
    return /^(?:[a-f0-9]{40,64}|PASS|FAIL|NOT_RUN|completed|failed|requires_action|in_progress|closed|assistant|user|function_call|function_call_output|message|GET|POST|DELETE)$/.test(value) ? value : "<omitted>";
  }
  if (Array.isArray(value)) return value.map(structuralEvidence);
  if (typeof value !== "object") return "<omitted>";
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, child]) =>
    [key, ["text", "output", "content"].includes(key) ? (child === null ? null : "<omitted>") : ["scenario", "error"].includes(key) && typeof child === "string" && /^[a-zA-Z0-9_.: -]{1,240}$/.test(child) ? child : structuralEvidence(child)]));
}
