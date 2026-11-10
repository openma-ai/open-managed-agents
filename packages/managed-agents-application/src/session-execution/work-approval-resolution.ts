/** Pure canonical approval evidence, shared by projection and finalization.
 * No authority: caller still fences the snapshot with root raw CAS, revision,
 * Work holder/generation and DB-clock TTL in its write transaction. */
export interface WorkApprovalResolutionInput {
  root: { inputId: string; turnId: string; expectedDocument: string };
  claim: { workId: string; generation: number; holder: string };
  /** Persisted canonical documents only, including consumption_claim. */
  documents: readonly string[];
}
export type WorkApprovalResolution =
  | { type: "resolved"; pendingRequestIds: string[] }
  | { type: "invalid" };
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
interface Fact { event: Json; source: Json; revision: number; index: number }
function parse(document: string): Fact | null {
  let event: unknown;
  try { event = JSON.parse(document); } catch { return null; }
  if (!record(event) || !record(event.source_position)) return null;
  const source = event.source_position;
  if (typeof source.revision !== "number" || !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      typeof source.index !== "number" || !Number.isSafeInteger(source.index) || source.index < 0) return null;
  return { event, source, revision: source.revision, index: source.index };
}
const compare = (a: Fact, b: Fact) => a.revision - b.revision || a.index - b.index;
const lane = (event: Json) => event.sessionThreadId ?? "sthr_primary";
function consumed(fact: Fact, input: WorkApprovalResolutionInput): boolean {
  const {event, source} = fact;
  const claim = source.consumption_claim;
  return source.consumed_by_execution_id === input.root.turnId && record(claim) &&
    claim.workId === input.claim.workId && claim.generation === input.claim.generation && claim.holder === input.claim.holder &&
    typeof event.processedAt === "string" && Number.isFinite(Date.parse(event.processedAt)) && event._queued !== true && event.cancelled_at_ms == null &&
    event.deferredUntilToolResults === undefined && event.deferred_until_tool_results === undefined;
}

/** Accumulate requests, never trust a later runtime status/result to erase one.
 * Only canonical user answers consumed by this root AND this claim discharge
 * them. Returned ids also let projection reject a partial pause that hides an
 * unanswered request. Budget and execution-terminal decisions stay elsewhere. */
export function inspectWorkApprovalResolution(input: WorkApprovalResolutionInput): WorkApprovalResolution {
  const root = parse(input.root.expectedDocument);
  if (!root || root.event.id !== input.root.inputId || (root.source.execution_id ?? root.event.id) !== input.root.turnId || !consumed(root, input)) return {type:"invalid"};
  const facts: Fact[] = [];
  for (const document of input.documents) {
    const fact = parse(document);
    if (!fact) return {type:"invalid"};
    if (compare(fact, root) > 0) facts.push(fact);
  }
  facts.sort(compare);
  const pending = new Map<string, "confirmation" | "custom" | "unknown">();
  const answered = new Set<string>();
  for (const {event, source, ...position} of facts) {
    if (lane(event) !== lane(root.event)) continue;
    const work = source.environment_work;
    const owned = source.execution_id === input.root.turnId && record(work) &&
      work.workId === input.claim.workId && work.generation === input.claim.generation;
    if (owned && typeof event.id === "string") {
      if (event.type === "agent.tool_use" && event.evaluatedPermission === "ask") pending.set(event.id, "confirmation");
      if (event.type === "agent.custom_tool_use") pending.set(event.id, "custom");
    }
    if (owned && event.type === "session.status_idle" && record(event.stopReason) && event.stopReason.type === "requires_action") {
      if (!Array.isArray(event.stopReason.eventIds) || event.stopReason.eventIds.some(id => typeof id !== "string" || !id)) return {type:"invalid"};
      // Legacy missing-tool evidence cannot be erased by a status transition.
      // Without a proven request kind, even an alleged consumed answer cannot
      // safely choose the approval/custom-result protocol.
      for (const id of event.stopReason.eventIds as string[]) if (!answered.has(id) && !pending.has(id)) pending.set(id, "unknown");
    }
    if (!consumed({event, source, ...position}, input)) continue;
    if (event.type === "user.tool_confirmation" && typeof event.toolUseId === "string" &&
        (event.result === "allow" || event.result === "deny") && pending.get(event.toolUseId) === "confirmation") { pending.delete(event.toolUseId); answered.add(event.toolUseId); }
    if (event.type === "user.custom_tool_result" && typeof event.customToolUseId === "string" &&
        pending.get(event.customToolUseId) === "custom") { pending.delete(event.customToolUseId); answered.add(event.customToolUseId); }
  }
  return {type:"resolved",pendingRequestIds:[...pending.keys()]};
}
