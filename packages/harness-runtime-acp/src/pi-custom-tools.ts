import { join } from "node:path";
import type { NodeAcpHarnessStateIo } from "./node.js";
import type { ManagedRecoveryEvent } from "./semantic-recovery.js";

/** Pi's ACP metadata is descriptive, not a tool-registration API. Use its
 * supported extension loader; canonical Work events remain the authority for
 * external results. Native placeholders never become canonical tool results. */
export function piCustomToolFiles(nativePath: string, tools: readonly Readonly<Record<string, unknown>>[]) {
  const custom = tools.filter(tool => tool.type === "custom");
  if (!custom.length) return null;
  const names = new Set<string>();
  for (const tool of custom) {
    if (typeof tool.name !== "string" || !tool.name || names.has(tool.name) ||
        ["read", "bash", "edit", "write", "glob", "grep", "ls", "tool_search"].includes(tool.name) ||
        !tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema)) {
      throw new Error("Invalid or conflicting Pi custom tool definition");
    }
    names.add(tool.name);
  }
  const agentDir = join(nativePath, "home", ".pi", "agent");
  const answersPath = join(agentDir, "oma-custom-results.json");
  return {
    names,
    answersPath,
    extensionPath: join(agentDir, "extensions", "oma-custom-tools.js"),
    source: `import fs from 'node:fs';
export default function(pi) {
 const definitions = ${JSON.stringify(custom)};
 const names = new Set(definitions.map(tool => tool.name));
 for (const tool of definitions) pi.registerTool({name:tool.name,label:tool.name,description:tool.description??tool.name,parameters:tool.input_schema,
  async execute(toolCallId,args) { return {content:[{type:'text',text:'Awaiting client tool result'}],details:{omaPendingCustom:{toolCallId,name:tool.name}}}; }
 });
 // Finish every ordinary tool in this model batch before parking. No next
 // sampling occurs until the host admits the complete canonical answer batch.
 pi.on('turn_end',(event,ctx)=>{if(event.toolResults.some(result=>names.has(result.toolName)&&result.details?.omaPendingCustom))ctx.abort();});
 pi.on('context',(event,ctx)=>{
  const answers=JSON.parse(fs.readFileSync(${JSON.stringify(answersPath)},'utf8'));
  return {messages:event.messages.map(message=>{
   if(message.role!=='toolResult'||!names.has(message.toolName)||!message.details?.omaPendingCustom)return message;
   const answer=Object.hasOwn(answers,message.toolCallId)?answers[message.toolCallId]:undefined;
   if(!answer){ctx.abort();throw Error('Outstanding OMA custom result');}
   return {...message,content:answer.content,isError:answer.isError,details:undefined};
  })};
 });
}
`,
  };
}

export async function writePiCustomAnswers(io: Pick<NodeAcpHarnessStateIo, "writeFile">, path: string,
  history: readonly ManagedRecoveryEvent[]) {
  const calls = new Set<string>();
  const answers: Record<string, {content: unknown; isError: boolean}> = Object.create(null);
  for (const event of history) {
    if (event.type === "agent.custom_tool_use") { calls.add(event.id); continue; }
    if (event.type === "agent.tool_result" && calls.has(event.tool_use_id) && !answers[event.tool_use_id]) {
      answers[event.tool_use_id] = {content:event.content,isError:event.is_error === true};
      continue;
    }
    if (event.type !== "user.custom_tool_result" || !calls.has(event.custom_tool_use_id) || answers[event.custom_tool_use_id]) continue;
    answers[event.custom_tool_use_id] = {content:event.content,isError:event.is_error === true};
  }
  await io.writeFile(path, JSON.stringify(answers));
}
