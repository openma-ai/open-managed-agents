import { CustomToolInvocations, type CustomInvocationScope } from './custom-tool-invocations';

export interface CoreCustomToolDefinition {
 name: string;
 description: string;
 input_schema: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
 return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function matchesType(value: unknown, type: string): boolean {
 switch (type) {
  case 'null': return value === null;
  case 'boolean': return typeof value === 'boolean';
  case 'object': return isRecord(value);
  case 'array': return Array.isArray(value);
  case 'string': return typeof value === 'string';
  case 'number': return typeof value === 'number' && Number.isFinite(value);
  case 'integer': return typeof value === 'number' && Number.isInteger(value);
  default: return true;
 }
}

/** Small, dependency-free JSON Schema evaluator for pinned custom-tool input.
 * The application layer keeps the schema opaque and only enforces the JSON
 * Schema keywords needed for tool arguments; adapters own richer validation
 * and transport concerns. Unknown annotations are intentionally ignored. */
function matchesSchema(value: unknown, schema: JsonSchema): boolean {
 const type = schema.type;
 if (typeof type === 'string' && !matchesType(value, type)) return false;
 if (Array.isArray(type) && !type.some(candidate => typeof candidate === 'string' && matchesType(value, candidate))) return false;
 if ('const' in schema && !Object.is(value, schema.const)) return false;
 if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(value, candidate))) return false;
 if (Array.isArray(schema.anyOf) && !schema.anyOf.some(candidate => isRecord(candidate) && matchesSchema(value, candidate))) return false;
 if (Array.isArray(schema.oneOf) && schema.oneOf.filter(candidate => isRecord(candidate) && matchesSchema(value, candidate)).length !== 1) return false;
 if (Array.isArray(schema.allOf) && !schema.allOf.every(candidate => isRecord(candidate) && matchesSchema(value, candidate))) return false;
 if (isRecord(schema.not) && matchesSchema(value, schema.not)) return false;

 if (typeof value === 'string') {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
  if (typeof schema.pattern === 'string') {
   try { if (!new RegExp(schema.pattern).test(value)) return false; } catch { return false; }
  }
 }
 if (typeof value === 'number') {
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false;
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false;
 }
 if (Array.isArray(value)) {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
  if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
  if (isRecord(schema.items) && !value.every(item => matchesSchema(item, schema.items as JsonSchema))) return false;
 }
 if (isRecord(value)) {
  const required = schema.required;
  if (Array.isArray(required) && required.some(key => typeof key !== 'string' || !(key in value))) return false;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(properties)) {
   if (key in value && isRecord(child) && !matchesSchema(value[key], child)) return false;
  }
  if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in properties))) return false;
  if (isRecord(schema.additionalProperties)) {
   for (const key of Object.keys(value)) {
    if (!(key in properties) && !matchesSchema(value[key], schema.additionalProperties as JsonSchema)) return false;
   }
  }
 }
 return true;
}

/** MCP tools/list + tools/call application handlers. An official MCP SDK owns
 * JSON-RPC/transport; it must not supply IDs or definitions to this authority.
 * Register only with a host that implements the pending sampling barrier and
 * canonical external-input admission. A receipt is NOT a model tool answer. */
export class CoreCustomToolMcp {
 private readonly definitions: Map<string, { definition: CoreCustomToolDefinition; validate: (value: unknown) => boolean }>;
 constructor(private readonly core: CustomToolInvocations, private readonly scope: CustomInvocationScope, definitions: readonly CoreCustomToolDefinition[]) {
  this.definitions=new Map();
  for (const definition of definitions) {
   if (!definition.name || this.definitions.has(definition.name)) throw new Error('Invalid or duplicate Core custom tool');
   const copy=structuredClone(definition);
   if (copy.input_schema.type!=='object') throw new Error('Core custom tool input schema must be an object');
   this.definitions.set(copy.name,{definition:copy,validate:value => matchesSchema(value, copy.input_schema)});
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
  if (!entry.validate(args)) throw new Error('Invalid Core custom tool arguments');
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
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.omaCustomInvocation)) return null;
  const envelope = value.omaCustomInvocation;
  if (Object.keys(envelope).length !== 2 || envelope.version !== 1 || typeof envelope.receipt !== 'string' || !isUuid(envelope.receipt)) return null;
  const invocation=await this.core.read(this.scope,envelope.receipt);
  if (invocation.state!=='unbound') throw new Error('Custom invocation already bound');
  return {receipt:invocation.receipt,name:invocation.name,input:invocation.arguments};
 }
}
