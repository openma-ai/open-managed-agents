// Real official MCP SDK stdio transport around the production Core handlers.
// SDK 1.29.0 is already lock-resolved transitively; no replacement RPC server.
import { fileURLToPath, URL } from 'node:url';
import { createBetterSqlite3SqlClient } from '@open-managed-agents/sql-client';
import { CustomToolInvocations } from '../../../managed-agents-application/src/custom-tool-invocations';
import { CoreCustomToolMcp } from '../../../managed-agents-application/src/custom-tool-mcp';
import { SqlCustomToolInvocations } from '../../src/custom-tool-invocations';
const sdk=new URL('../../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/',import.meta.url);
const {Server}=await import(fileURLToPath(new URL('server/index.js',sdk)));
const {StdioServerTransport}=await import(fileURLToPath(new URL('server/stdio.js',sdk)));
const {ListToolsRequestSchema,CallToolRequestSchema}=await import(fileURLToPath(new URL('types.js',sdk)));
const sql=await createBetterSqlite3SqlClient(process.argv[2]!);
const scope=JSON.parse(process.argv[3]!); // Synthetic fixture scope, never credentials.
const core=new CoreCustomToolMcp(new CustomToolInvocations(new SqlCustomToolInvocations(sql)),scope,[{
 name:'approve',description:'Core-owned approval',input_schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
}]);
const server=new Server({name:'oma-core-test',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>core.listTools());
server.setRequestHandler(CallToolRequestSchema,(request:{params:{name:string;arguments?:Record<string,unknown>}})=>core.callTool(request.params));
await server.connect(new StdioServerTransport());
