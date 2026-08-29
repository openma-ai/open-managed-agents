# @open-managed-agents/mcp

Runtime-neutral MCP client Port for OpenMA. The HTTP adapter delegates protocol
negotiation, Streamable HTTP/SSE, pagination, sessions, and schema validation to
the official `@modelcontextprotocol/client` v2 package.

The package does not depend on a harness or model SDK. Applications provide the
network boundary through `fetch`, so Node can use global fetch while Workers can
use a service-binding proxy that keeps vault credentials outside the harness.

```ts
import { connectHttpMcpClient } from "@open-managed-agents/mcp";

const client = await connectHttpMcpClient({
  url: "https://mcp.example.com/rpc",
  clientInfo: { name: "my-openma-app", version: "1.0.0" },
  fetch: platformFetch,
});

const tools = await client.listTools();
const result = await client.callTool({
  name: tools[0].name,
  arguments: {},
});

await client.close();
```

`close()` is idempotent and bounds remote session termination before always
closing local transport resources.
