import { expect, it } from 'vitest';
import { decodeManagedAcpSessionSnapshot } from '../src/node-supervisor';
it('rejects legacy SSE in the Work session snapshot with the policy error', () => {
 expect(() => decodeManagedAcpSessionSnapshot({agent:{id:'agent',version:1,model:{id:'fixture'},system:null,mcp_servers:[{type:'sse',name:'old',url:'http://localhost/mcp'}]}} as never)).toThrow('MCP_SSE_UNSUPPORTED');
});
