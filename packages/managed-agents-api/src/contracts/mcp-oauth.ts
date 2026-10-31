import { z } from "zod";

// OpenMA extension wire contract, not part of the Anthropic Managed Agents
// API: browser MCP OAuth that ends in an `mcp_oauth` Vault credential.

export const mcpOAuthAuthorizeBodySchema = z
  .object({
    mcp_server_url: z.string().min(1),
    vault_id: z.string().min(1),
    credential_id: z.string().min(1).optional(),
    redirect_uri: z.string().min(1).optional(),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
  })
  .strict();

export const mcpOAuthCliAuthorizeBodySchema = mcpOAuthAuthorizeBodySchema
  .omit({ redirect_uri: true })
  .strict();

export const mcpOAuthCliClaimBodySchema = z
  .object({
    flow_id: z.string().min(1),
    claim_token: z.string().min(1),
  })
  .strict();
