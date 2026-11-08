// Session subagents domain (#545 §0.7). See ./subagents.ts.
export {
  SessionSubagents,
  NO_SUBAGENT_OUTPUT,
  type SubagentStatus,
  type SubagentState,
  type CreateSubagent,
  type SubagentControl,
  type SubagentThread,
  type SubagentThreadStorePort,
  type SubagentFact,
  type SubagentFactsPort,
  type SubagentEvent,
  type SubagentEventsPort,
  type SubagentTurnInput,
  type SubagentTurnResult,
  type SubagentTurnRunnerPort,
  type SubagentAdmissionPort,
  type SessionSubagentsDependencies,
} from "./subagents.js";
export { subagentWireFrame, type SubagentWireFrame } from "./wire-events.js";
export {
  selectSubagent,
  GENERAL_SUBAGENT_ID,
  type SubagentRoster,
  type SubagentSelection,
} from "./roster.js";
