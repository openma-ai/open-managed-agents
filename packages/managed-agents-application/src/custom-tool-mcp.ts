import { z } from 'zod';
import { CustomToolInvocations, type CustomInvocationScope } from './custom-tool-invocations';

export interface CoreCustomToolDefinition {
 name: string;
 description: string;
 input_schema: Record<string, unknown>;
}

/** MCP tools/list + tools/call application handlers. An official MCP SDK owns
 * JSON-RPC/transport; it must not supply IDs or definitions to this authority.
 * Register only with a host that implements the pending sampling barrier and
 * canonical external-input admission. A receipt is NOT a model tool answer. */
export class CoreCustomToolMcp {
 private readonly definitions: Map<string, { definition: CoreCustomToolDefinition; validate: z.ZodType }>;
 constructor(private readonly core: CustomToolInvocations, private readonly scope: CustomInvocationScope, definitions: readonly CoreCustomToolDefinition[]) {
  this.definitions=new Map();
  for (const definition of definitions) {
   if (!definition.name || this.definitions.has(definition.name)) throw new Error('Invalid or duplicate Core custom tool');
   const copy=structuredClone(definition);
   if (copy.input_schema.type!=='object') throw new Error('Core custom tool input schema must be an object');
   this.definitions.set(copy.name,{definition:copy,validate:z.fromJSONSchema(copy.input_schema)});
  }
 }
 listTools() {
  return {tools:[...this.definitions.values()].map(({definition:d})=>({name:d.name,description:d.description,inputSchema:structuredClone(d.input_schema) as {type:"object";[key:string]:unknown}}))};
 }
 async callTool(params: {name:string;arguments?:Record<string,unknown>}) {
  const entry=this.definitions.get(params.name);
  if (!entry) throw new Error('Unknown Core custom tool');
  const args=params.arguments ?? {};
  // Validate without rewriting arguments. Definitions come from the pinned
  // Agent, never a sandbox-supplied JSON schema.
  if (!entry.validate.safeParse(args).success) throw new Error('Invalid Core custom tool arguments');
  const invocation=await this.core.begin(this.scope,entry.definition,args);
  const receipt={omaCustomInvocation:{version:1,receipt:invocation.receipt}};
  return {content:[{type:'text' as const,text:JSON.stringify(receipt)}],structuredContent:receipt,isError:false};
 }
 /** Resolve only the opaque reference. The Work projection transaction owns
  * binding together with canonical publication; this method never mutates. */
 async prepareNativeResult(nativeCallId: string, content: unknown) {
  if (!nativeCallId || nativeCallId.length > 1024) throw new Error('Invalid native call ID');
  if (!Array.isArray(content) || content.length!==1 || content[0]?.type!=='text' || typeof content[0]?.text!=='string') return null;
  let value: unknown;
  try {value=JSON.parse(content[0].text);} catch {return null;}
  // The managed ACP projector serializes native rawOutput. Pi, for example,
  // retains the standard MCP result's content/structuredContent inside that
  // object. Inspect only this documented envelope, never recursively search
  // arbitrary ordinary-tool text for a receipt.
  if (value && typeof value==='object' && 'content' in value && Array.isArray(value.content)) {
   if ('isError' in value && value.isError===true) return null;
   const blocks=value.content;
   if (blocks.length!==1 || blocks[0]?.type!=='text' || typeof blocks[0]?.text!=='string') return null;
   try {value=JSON.parse(blocks[0].text);} catch {return null;}
  }
  const parsed=z.object({omaCustomInvocation:z.object({version:z.literal(1),receipt:z.uuid()}).strict()}).strict().safeParse(value);
  if (!parsed.success) return null;
  const invocation=await this.core.read(this.scope,parsed.data.omaCustomInvocation.receipt);
  if (invocation.state!=='unbound') throw new Error('Custom invocation already bound');
  return {receipt:invocation.receipt,name:invocation.name,input:invocation.arguments};
 }
}
