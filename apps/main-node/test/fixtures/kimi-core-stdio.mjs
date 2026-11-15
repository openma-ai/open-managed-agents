import {Server} from '../../../../packages/harness-runtime-acp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import {StdioServerTransport} from '../../../../packages/harness-runtime-acp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '../../../../packages/harness-runtime-acp/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
const server=new Server({name:'oma-core-behavior-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'approve',description:'Approve operation; wait for an external decision',inputSchema:{type:'object',properties:{label:{type:'string'}},required:['label']}}]}));
server.setRequestHandler(CallToolRequestSchema,async(request)=>{const r=await fetch(process.argv[2]+'/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request.params)});if(!r.ok)throw Error('Core bridge rejected '+r.status);return r.json();});
await server.connect(new StdioServerTransport());
