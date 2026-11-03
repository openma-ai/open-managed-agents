/**
 * OpenMA extension, not part of the Anthropic Managed Agents API:
 *
 *   POST /v1/oma/vaults/:vaultId/cap_cli_device_flow        { cli_id }
 *   POST /v1/oma/vaults/:vaultId/cap_cli_device_flow/poll   { flow_token }
 *
 * Starts and polls an OAuth Device Authorization Grant (RFC 8628) whose
 * approval is stored as a managed `cap_cli` Vault credential.
 */
import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import {
  capCliDeviceFlowPollBodySchema,
  capCliDeviceFlowStartBodySchema,
} from "../contracts/cap-cli-device-flow";
import { apiError, invalidRequest, notFound } from "../errors";
import {
  toCapCliDeviceFlowPollResponse,
  toCapCliDeviceFlowResponse,
} from "../mappers/cap-cli-device-flow";
import type { CapCliDeviceFlowApplicationPort } from "../ports/cap-cli-device-flow";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function buildCapCliDeviceFlowRoutes(
  source: ApplicationPortSource<CapCliDeviceFlowApplicationPort>,
): Hono {
  const app = new Hono();

  app.post("/:vaultId/cap_cli_device_flow", async (c) => {
    const parsed = capCliDeviceFlowStartBodySchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return c.json(invalidRequest("Body must be { cli_id }"), 400);
    const vaultId = c.req.param("vaultId");
    const result = await resolveApplicationPort(source, c).startDeviceFlow({
      vaultId,
      cliId: parsed.data.cli_id,
    });
    switch (result.type) {
      case "not_found":
        return c.json(notFound(`Vault ${vaultId} was not found`), 404);
      case "invalid_request":
        return c.json(invalidRequest(result.message), 400);
      case "upstream_error":
        return c.json(apiError(`Device authorization failed: ${result.message}`), 502);
      case "started":
        return c.json(toCapCliDeviceFlowResponse(result.flow), 200);
    }
  });

  app.post("/:vaultId/cap_cli_device_flow/poll", async (c) => {
    const parsed = capCliDeviceFlowPollBodySchema.safeParse(await readJson(c.req.raw));
    if (!parsed.success) return c.json(invalidRequest("Body must be { flow_token }"), 400);
    const result = await resolveApplicationPort(source, c).pollDeviceFlow({
      vaultId: c.req.param("vaultId"),
      flowToken: parsed.data.flow_token,
    });
    if (result.type === "not_found") {
      return c.json(notFound("Device flow was not found"), 404);
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    return c.json(toCapCliDeviceFlowPollResponse(result), 200);
  });

  return app;
}
