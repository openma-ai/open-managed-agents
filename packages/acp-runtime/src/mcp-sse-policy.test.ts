import { expect, it, vi } from 'vitest';
import { AcpRuntimeImpl } from './runtime';
import { createAcpRuntime } from './placement';
import { projectAcpSandboxMcpServers } from './sandbox-agent';
const legacy = { type: 'sse' as const, name: 'approve', url: 'http://localhost/mcp', headers: [] };
const error = 'MCP_SSE_UNSUPPORTED';
it.each(['direct', 'placement'])('rejects legacy SSE before %s process launch', async kind => {
 const spawn = vi.fn(async () => { throw new Error('CHILD_STARTED'); });
 const runtime = kind === 'direct' ? new AcpRuntimeImpl({spawn}) : createAcpRuntime({type:'local', spawner:{spawn}});
 await expect(runtime.start({agent:{command:'not-executed',args:[],cwd:'/tmp'},mcpServers:[legacy]})).rejects.toThrow(error);
 expect(spawn).not.toHaveBeenCalled();
});
it('rejects persisted legacy transport before sandbox proxy rewrite', () => {
 expect(() => projectAcpSandboxMcpServers({sessionId:'s', gatewayBaseUrl:'http://localhost', sessionsToken:'fixture',servers:[legacy as never]})).toThrow(error);
});
