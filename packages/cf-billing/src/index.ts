// @open-managed-agents/cf-billing
//
// Cloudflare Worker helpers used by apps/main:
//   - cf-api    : Worker script-settings mutations (add/remove service bindings)
//   - cost attribution is kept as a compatibility re-export; new consumers
//     should depend on @open-managed-agents/cost-attribution-cloudflare.
//
// Pure HTTP — no workspace runtime deps. apps/main is the only consumer
// today (cost-report route + environment provisioning).
//
// Despite the package name, this is NOT customer charging / wallet code.

export * from "./cf-api";
export * from "@open-managed-agents/cost-attribution-cloudflare";
