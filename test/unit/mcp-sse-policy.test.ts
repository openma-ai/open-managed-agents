import { expect, it } from 'vitest';
import { injectMcpServersIntoSnapshot, refreshIntegrationMcpServers } from '../../packages/integrations-core/src/mcp-snapshot';
import { agentMcpServerInputSchema } from '../../packages/managed-agents-api/src/contracts/agent-input-components';
const legacy = { type: 'sse' as const, name: 'approve', url: 'http://localhost/mcp', headers: [] };
const error = 'MCP_SSE_UNSUPPORTED';
it.each([injectMcpServersIntoSnapshot, refreshIntegrationMcpServers])('rejects injected and persisted SSE snapshots', change => {
 expect(() => change({} as never,[legacy])).toThrow(error);
 expect(() => change({mcp_servers:[legacy]} as never,[])).toThrow(error);
 expect(change({} as never,[{...legacy,type:'http'}]).mcp_servers?.[0].type).toBe('http');
});
it('public schema explicitly rejects SSE and keeps URL and stdio', () => {
 const parsed = agentMcpServerInputSchema.safeParse(legacy);
 expect(parsed.success).toBe(false);
 if (!parsed.success) expect(parsed.error.message).toContain(error);
 expect(agentMcpServerInputSchema.parse({type:'url',name:'a',url:'http://localhost/mcp'}).type).toBe('url');
 expect(agentMcpServerInputSchema.parse({type:'stdio',name:'a',command:'/usr/bin/node'}).type).toBe('stdio');
});
