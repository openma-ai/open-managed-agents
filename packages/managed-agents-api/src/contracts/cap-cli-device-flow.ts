import { z } from "zod";

// OpenMA extension wire contract, not part of the Anthropic Managed Agents
// API: OAuth device flow that ends in a `cap_cli` Vault credential.

export const capCliDeviceFlowStartBodySchema = z
  .object({ cli_id: z.string().min(1) })
  .strict();

export const capCliDeviceFlowPollBodySchema = z
  .object({ flow_token: z.string().min(1) })
  .strict();
