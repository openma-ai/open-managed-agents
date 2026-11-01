/** Local re-export so node-managed-session-runtime stays free of the banned
 *  `@open-managed-agents/shared` import (architecture lint in main-node). */
export {
  processSessionClocks,
  type SessionClockRegistry,
} from "@open-managed-agents/shared";
