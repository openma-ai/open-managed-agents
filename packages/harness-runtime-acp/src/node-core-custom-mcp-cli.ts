import {readFile} from 'node:fs/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';

// Native stdio transport only. The immutable roster is the pinned Core snapshot.
// Each call captures one host-admitted turn; the host HTTP authority validates it
// again. Neither this process, a request ID nor an open connection owns a call.
const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const server=new Server({name:'oma-custom-tools-transport',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:config.tools}));
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
 const scope=JSON.parse(await readFile(config.scopePath,'utf8'));
 if(!scope||typeof scope.url!=='string'||typeof scope.token!=='string')throw new McpError(ErrorCode.InvalidRequest,'No admitted Core custom tool turn');
 const client=new Client({name:'oma-work-custom-tools',version:'1.0.0'});
 try {
  await client.connect(new StreamableHTTPClientTransport(new URL(scope.url),{requestInit:{headers:{authorization:`Bearer ${scope.token}`}}}),{signal:extra.signal});
  return await client.callTool(request.params,undefined,{signal:extra.signal});
 }catch {throw new McpError(ErrorCode.InternalError,'Core custom tool request failed; outcome must not be replayed automatically');}
 finally {await client.close();}
});
await server.connect(new StdioServerTransport());
