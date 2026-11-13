import Database from "better-sqlite3";
// Controlled model responses; real HTTP/SQLite, child-process SIGKILL/restart,
// bash filesystem effects, and a loopback JSON-RPC MCP tool with a real effect.
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { killProcessTree, detachedProcessOptions } from "./helpers/process-tree";
const root=resolve(import.meta.dirname,"../../..");
const custom=(id:string)=>({id,name:"approve",args:{ticket:id}});
const bash={id:"b1",name:"bash",args:{command:"printf x >> effect.txt; cat effect.txt"}};
const mcp={id:"m1",name:"mcp__docs__effect",args:{}};
it.each([
 ["custom-first",[custom("c1"),bash]], ["custom-last",[bash,custom("c1")]],
 ["mcp",[custom("c1"),mcp]], ["multiple",[custom("c1"),bash,mcp,custom("c2")]],
] as const)("%s persists mixed results across real process death",async(label,calls)=>{
 if(process.env.PR545_GATE_EVIDENCE)mkdirSync(process.env.PR545_GATE_EVIDENCE,{recursive:true});
 const dir=mkdtempSync(join(tmpdir(),"oma-mixed-process-"));writeFileSync(join(dir,"calls.json"),JSON.stringify(calls));
 const children:ChildProcess[]=[];const logs:string[]=[];
 const rpc=createServer(async(req,res)=>{
  if(req.method!=="POST"){res.writeHead(405).end();return;}
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);
  const m=JSON.parse(Buffer.concat(chunks).toString());
  if(m.id===undefined){res.writeHead(202).end();return;}
  let result:any;
  if(m.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"effect-counter",version:"1"}};
  else if(m.method==="tools/list")result={tools:[{name:"effect",description:"append one durable effect",inputSchema:{type:"object",properties:{}}}]};
  else if(m.method==="tools/call"){appendFileSync(join(dir,"mcp-effect.txt"),"x");result={content:[{type:"text",text:"effect committed"}]};}
  else {res.writeHead(400).end();return;}
  res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
 });await new Promise<void>(r=>rpc.listen(0,"127.0.0.1",r));
 const samples=()=>existsSync(join(dir,"samples.jsonl"))?readFileSync(join(dir,"samples.jsonl"),"utf8").trim().split("\n").map(s=>JSON.parse(s)):[];
 async function start(){
  rmSync(join(dir,"ready.json"),{force:true});
  const child=spawn(join(root,"apps/main-node/node_modules/.bin/tsx"),[join(root,"apps/main-node/test/mixed-process-restart.fixture.ts"),dir],{...detachedProcessOptions,cwd:root,env:{PATH:process.env.PATH,NODE_ENV:"test"},stdio:["ignore","pipe","pipe"]});children.push(child);
  child.stdout?.on("data",b=>logs.push(b.toString()));child.stderr?.on("data",b=>logs.push(b.toString()));
  await expect.poll(()=>existsSync(join(dir,"ready.json")),{timeout:20000}).toBe(true);
  const ready=JSON.parse(readFileSync(join(dir,"ready.json"),"utf8"));return {child,pid:ready.pid,base:`http://127.0.0.1:${ready.port}`};
 }
 let host:Awaited<ReturnType<typeof start>>;
 const request=async(path:string,body?:unknown)=>{const r=await fetch(host.base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();expect(r.ok,JSON.stringify(v)).toBe(true);return v as any;};
 try{
  host=await start();
  await request("/v1/oma/model_cards",{provider:"ant",model_id:"mixed-process-model",api_key:"synthetic",base_url:"http://unused.invalid"});
  const agent=await request("/v1/agents",{name:label,model:"mixed-process-model",system:"test",_oma:{harness:"mixed-process"},mcp_servers:[{name:"docs",type:"url",url:`http://127.0.0.1:${(rpc.address() as any).port}/mcp`}],tools:[{type:"agent_toolset_20260401"},{type:"mcp_toolset",mcp_server_name:"docs"},{type:"custom",name:"approve",description:"client approval",input_schema:{type:"object",properties:{ticket:{type:"string"}},required:["ticket"]}}]});
  const environment=await request("/v1/environments",{name:label,config:{type:"cloud",networking:{type:"unrestricted"}}});
  const session=await request("/v1/sessions",{agent:{type:"agent",id:agent.id,version:agent.version},environment_id:environment.id});const path=`/v1/sessions/${session.id}/events`;
  const history=async()=>(await request(path+"?limit=1000&order=asc")).data as any[];
  await request(path,{events:[{type:"user.message",content:[{type:"text",text:"mixed"}]}]});
  await expect.poll(async()=>(await history()).some(e=>e.type==="session.status_idle"&&e.stop_reason?.type==="requires_action"),{timeout:15000}).toBe(true);
  const before=await history();const ordinary=calls.filter(c=>c.name!=="approve");
  for(const call of ordinary){const result=before.findIndex(e=>(e.tool_use_id??e.mcp_tool_use_id)===call.id);expect(result).toBeGreaterThan(-1);expect(result).toBeLessThan(before.findIndex(e=>e.type==="session.status_idle"));}
  expect(samples()).toHaveLength(1);const pid=host.pid;await killProcessTree(host.child,"SIGKILL");host=await start();expect(host.pid).not.toBe(pid);
  const ids=calls.filter(c=>c.name==="approve").map(c=>c.id);
  const answer=async(id:string)=>request(path,{events:[{type:"user.custom_tool_result",custom_tool_use_id:id,content:[{type:"text",text:"answer:"+id}]}]});
  if(ids.length>1){await answer(ids[0]!);await answer(ids[0]!);await expect.poll(async()=>(await history()).filter(e=>e.type==="session.status_idle").length).toBeGreaterThan(1);expect(samples()).toHaveLength(1);}
  for(const id of ids.length>1?ids.slice(1):ids)await answer(id);
  await expect.poll(async()=>(await history()).some(e=>e.type==="session.status_idle"&&e.stop_reason?.type==="end_turn"),{timeout:15000}).toBe(true);
  let after=await history();expect(samples()).toHaveLength(2);expect(samples().some(x=>x.unexpected)).toBe(false);
  const messages=samples()[1].messages;const turn=messages.slice(messages.findIndex((m:any)=>m.role==="user"));expect(turn.map((m:any)=>m.role)).toEqual(["user","assistant",...calls.map(()=>"toolResult")]);expect(turn.slice(2).map((m:any)=>m.toolCallId).sort()).toEqual(calls.map(c=>c.id).sort());
  if(calls.some(c=>c.name==="bash"))expect(readFileSync(join(dir,"sandboxes",session.id,"effect.txt"),"utf8")).toBe("x");
  if(calls.some(c=>c.name===mcp.name))expect(readFileSync(join(dir,"mcp-effect.txt"),"utf8")).toBe("x");
  const settled=async()=>{const db=new Database(join(dir,"oma.db"),{readonly:true});try{return (db.prepare("SELECT COUNT(*) AS n FROM managed_session_executions WHERE state IN ('queued','running')").get() as any).n;}finally{db.close();}};
  await answer(ids[0]!);await expect.poll(settled).toBe(0);expect(samples()).toHaveLength(2);
  await request(path,{events:[{type:"user.message",content:[{type:"text",text:"a new round"}]}]});
  await expect.poll(async()=>{const events=await history();return events.filter(e=>e.type==="session.status_idle").at(-1)?.stop_reason?.type;},{timeout:15000}).toBe("requires_action");
  await expect.poll(()=>samples().length).toBe(3);
  await answer(ids[0]!);await expect.poll(settled).toBe(0);expect(samples()).toHaveLength(3);
  for(const id of ids)await answer(id+"-r2");
  await expect.poll(async()=>(await history()).filter(e=>e.type==="session.status_idle").at(-1)?.stop_reason?.type,{timeout:15000}).toBe("end_turn");
  await expect.poll(settled).toBe(0);expect(samples()).toHaveLength(4);after=await history();
  if(calls.some(c=>c.name==="bash"))expect(readFileSync(join(dir,"sandboxes",session.id,"effect.txt"),"utf8")).toBe("xx");
  if(calls.some(c=>c.name===mcp.name))expect(readFileSync(join(dir,"mcp-effect.txt"),"utf8")).toBe("xx");
  if(process.env.PR545_GATE_EVIDENCE){const out=join(process.env.PR545_GATE_EVIDENCE,`mixed-${label}`);mkdirSync(out,{recursive:true});for(const [name,value]of Object.entries({before,after,samples:samples(),summary:{session_id:session.id,first_pid:pid,restarted_pid:host.pid,ordinary_calls_per_round:ordinary.length,rounds:2,side_effect_count_per_ordinary_call:2}}))writeFileSync(join(out,name+".json"),JSON.stringify(value,null,2));}
 }finally{
  for(const c of children)await killProcessTree(c,"SIGKILL");rpc.closeAllConnections();await new Promise<void>(r=>rpc.close(()=>r()));
  if(process.env.PR545_GATE_EVIDENCE)writeFileSync(join(process.env.PR545_GATE_EVIDENCE,`mixed-${label}.log`),logs.join(""));
  rmSync(dir,{recursive:true,force:true});
 }
},90000);
