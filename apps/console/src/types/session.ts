import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

/**
 * The Console consumes the Managed Agents session resource verbatim. Product
 * presentation concerns (for example, flattening paged results into a feed)
 * belong in query/view adapters, not in a second wire-model definition.
 */
export type SessionRecord = BetaManagedAgentsSession;
