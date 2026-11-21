import type { HarnessCatalog } from "@open-managed-agents/api-types";
import {
  ACP_PROXY_HARNESS_DESCRIPTOR,
  CORE_HARNESS_DESCRIPTORS,
} from "@open-managed-agents/api-types";

/**
 * Cloudflare has a split control-plane/agent-worker composition. The agent
 * worker owns the factories, while this route owns the public deployment
 * catalog. Keep the descriptor source shared with the worker registration so
 * the Console never discovers a different API surface than the runtime.
 */
export const CLOUDFLARE_HARNESS_CATALOG: HarnessCatalog = {
  object: "list",
  data: [...CORE_HARNESS_DESCRIPTORS, ACP_PROXY_HARNESS_DESCRIPTOR],
  default_harness_id: "pi",
};
