import {
  planHostedInferenceRequest,
  type HostedInferenceRequestInput,
} from "@open-managed-agents/inference-proxy";
import { proxyUpstream } from "./forward";

/** Plan a hosted inference call (pinned model, host-resolved credentials)
 * and send it, or return the plan's error response. */
export function sendHostedInference(
  input: HostedInferenceRequestInput & { readonly fetcher?: typeof fetch },
): Promise<Response> {
  const plan = planHostedInferenceRequest(input);
  if (plan instanceof Response) return Promise.resolve(plan);
  return proxyUpstream({
    url: plan.url,
    method: plan.method,
    headers: plan.headers,
    body: plan.body,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
