import type { Spawner } from "@open-managed-agents/acp-runtime";
import type { NodeAcpHarnessStateIo } from "./node.js";

const operation = "const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process'),util=require('node:util');(async()=>{let raw='';for await(const chunk of process.stdin)raw+=chunk;const r=JSON.parse(raw);try{let value;if(r.op==='exec')value=(await util.promisify(cp.execFile)('/bin/sh',['-c',r.command],{maxBuffer:16777216})).stdout;else if(r.op==='read')value=await fs.readFile(r.path,'utf8');else{await fs.mkdir(path.dirname(r.path),{recursive:true});await fs.writeFile(r.path,Buffer.from(r.content,'base64'));}process.stdout.write(JSON.stringify({value}));}catch(e){process.stdout.write(JSON.stringify({error:{message:e.message,code:e.code}}));}})().catch(()=>process.exit(1));";

/** Workspace paths and state-management shell must never be accessed as root. */
export function createE2BStateIo(spawner: Spawner, workspacePath = "/workspace"): NodeAcpHarnessStateIo {
  async function request(body: Record<string, unknown>): Promise<string> {
    const child = await spawner.spawn({command: "/usr/local/bin/node", args: ["-e", operation], cwd: workspacePath,
      env: {PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/oma-worker"}});
    async function collect(stream: ReadableStream<Uint8Array>) {
      const reader=stream.getReader(); const decoder=new TextDecoder(); let text="";
      try {for (;;) {const value=await reader.read(); if(value.done) return text+decoder.decode(); text+=decoder.decode(value.value,{stream:true});}}
      finally {reader.releaseLock();}
    }
    const output=collect(child.stdout); const diagnostics=collect(child.stderr);
    const writer=child.stdin.getWriter();
    try {await writer.write(new TextEncoder().encode(JSON.stringify(body))); await writer.close();}
    catch(error) {await child.kill("SIGKILL"); throw error;}
    finally {writer.releaseLock();}
    const [text,,exit]=await Promise.all([output,diagnostics,child.exited]);
    if(exit.code!==0) throw new Error("Isolated E2B state operation failed");
    const result=JSON.parse(text) as {value?: string;error?: {message:string;code?:string}};
    if(result.error) throw Object.assign(new Error(result.error.message),{code:result.error.code});
    return result.value ?? "";
  }
  const resolve=(path:string)=>path==="/workspace"?workspacePath:path.startsWith("/workspace/")?workspacePath+path.slice(10):path;
  return {
    readFile: path=>request({op:"read",path:resolve(path)}),
    async writeFile(path,content) {await request({op:"write",path:resolve(path),content:Buffer.from(content).toString("base64")});},
    async writeFileBytes(path,content) {await request({op:"write",path:resolve(path),content:Buffer.from(content).toString("base64")});},
    exec: command=>request({op:"exec",command}),
  };
}
