import { AcpRuntimeImpl as CommonAcpRuntime, type SessionOptions } from "@openma/common/acp-runtime";
import { rejectLegacyMcpSse } from "./mcp-transport-policy.js";

export class AcpRuntimeImpl extends CommonAcpRuntime {
  override async start(options: SessionOptions) {
    rejectLegacyMcpSse(options.mcpServers);
    return super.start(options);
  }
}
