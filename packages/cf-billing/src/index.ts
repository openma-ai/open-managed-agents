// @open-managed-agents/cf-billing
//
// Cloudflare-side billing & deployment helpers used by apps/main:
//   - cf-api    : Worker script-settings mutations (add/remove service bindings)
//   - cost attribution is kept as a compatibility re-export; new consumers
//     should depend on @open-managed-agents/cost-attribution-cloudflare.
//
// Pure HTTP — no workspace runtime deps. apps/main is the only consumer
// today (cost-report route + environment provisioning).

export * from "./cf-api";
export * from "@open-managed-agents/cost-attribution-cloudflare";
