// Cloudflare adapter for the generic Session work admission port. Forwards to
// the optional SESSION_ADMISSION binding; unbound or failing → admit-all.
import type { SessionWorkAdmissionPort } from "@open-managed-agents/managed-agents-application";
import { admitViaSessionAdmissionHook, type Env } from "@open-managed-agents/shared";

export function cfSessionWorkAdmission(env: Pick<Env, "SESSION_ADMISSION">): SessionWorkAdmissionPort {
  return { admit: (input) => admitViaSessionAdmissionHook(env.SESSION_ADMISSION, input) };
}
