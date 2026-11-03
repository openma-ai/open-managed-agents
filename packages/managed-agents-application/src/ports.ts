// Moved to @openma/core (#434). Kept so existing imports keep working.
export type * from "@openma/core/ports";
// OpenMA extension Ports that are not part of @openma/core yet (ADR 0015).
export * from "./ports/cap-cli-device-flow";
export * from "./ports/mcp-oauth";
