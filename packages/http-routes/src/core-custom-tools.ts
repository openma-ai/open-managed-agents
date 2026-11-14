import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/** Transport only. The host resolves the execution capability, pinned Agent,
 * canonical consumed turn and statement-fenced Core before connecting the SDK.
 * No JSON-RPC id, caller-supplied definition or HTTP connection owns a call. */
export function buildCoreCustomToolsRoutes(dependencies: {
  authorize(input: { token: string; sessionId: string; turnId: string }): Promise<null | {
    listTools(): { tools: Array<{ name: string; description: string; inputSchema: {type:"object";[key:string]:unknown} }> };
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
      content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError: boolean;
    }>;
  }>;
}) {
  const routes = new Hono();
  routes.all('/:sessionId/custom-tools/:turnId/mcp', async c => {
    const token = /^Bearer (\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    let core: Awaited<ReturnType<typeof dependencies.authorize>>;
    try { core = await dependencies.authorize({token,sessionId:c.req.param('sessionId'),turnId:c.req.param('turnId')}); }
    catch { return c.json({error:'Core custom tool authority unavailable'},503); }
    if (!core) return c.json({error:'Current execution and canonical turn required'},401);
    const server = new Server({name:'oma-custom-tools',version:'1.0.0'},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => core!.listTools());
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try { return await core!.callTool(request.params); }
      catch { throw new McpError(ErrorCode.InvalidRequest,'Custom tool invocation rejected by Core'); }
    });
    // Stateless Streamable HTTP: receipts, not transport sessions, survive a
    // process restart. JSON responses finish before the transport is closed.
    const transport = new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally { await server.close(); }
  });
  return routes;
}
