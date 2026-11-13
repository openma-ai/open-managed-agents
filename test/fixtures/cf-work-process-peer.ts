import { promisify } from "node:util";
import { readlinkSync, unlinkSync, cpSync } from "node:fs";
// Local subprocess/provider transport for workerd tests. No inference or cloud IO.
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { LocalSubprocessSandbox } from "../../packages/sandbox/src/adapters/local-subprocess";
import { parseExecResult } from "../../packages/sandbox/src/index";
const live:Array<()=>Promise<void>>=[];
export async function closeCfWorkPeers(){for(const close of live.splice(0))await close();}
export async function startCfWorkPeer(){
 const root=await mkdtemp(join(tmpdir(),"resource-cf-work-"));let sandbox:LocalSubprocessSandbox;
 let generation=0,child:ChildProcess|undefined,exited=true;let config:any;let mounts:any[]=[];const discarded=new Set<string>();const observations:any[]=[];const publications:any[]=[];const pending:any[]=[];const replies=new Map<string,(r:any)=>void>();
 const agent=join(root,"agent.mjs"),supervisor=join(root,"supervisor.mjs");
 for(const [source,target] of [["resource-acp-agent.ts",agent],["resource-work-child.ts",supervisor]])execFileSync(join(process.cwd(),"node_modules/.bin/esbuild"),["apps/main-node/test/fixtures/"+source,"--bundle","--platform=node","--format=esm","--target=node22","--outfile="+target,'--banner:js=import {createRequire as __fixtureRequire} from "node:module";const require=__fixtureRequire(import.meta.url);'],{stdio:"pipe"});
 const namespace=(value:string)=>{
  const workspace=join(root,"runtime-"+generation);
  return value.replaceAll(workspace,"__RESOURCE_PHYSICAL_WORKSPACE__").replace(/\/(workspace|mnt|oma|tmp)(?=[/\s'"\\;)]|$)/g,(_all,name:string)=>workspace+(name==="workspace"?"":name==="mnt"?"/.mnt":name==="oma"?"/.mnt/oma":"/.tmp")).replaceAll("__RESOURCE_PHYSICAL_WORKSPACE__",workspace);
 };
 const execute=async(command:string)=>{
  try {const r=await promisify(execFile)("/bin/sh",["-c",namespace(command)],{cwd:join(root,"runtime-"+generation),timeout:30000,maxBuffer:8*1024*1024});return r.stdout+r.stderr;}
  catch(e){const r=e as {stdout?:string;stderr?:string;code?:number};return (r.stdout??"")+(r.stderr??"")+`\n[exit exit=${typeof r.code==="number"?r.code:1}]`;}
 };
 const stop=async()=>{if(child&&!exited){const done=new Promise<void>(r=>child!.once("exit",()=>r()));child.send("stop");await done;}};
 const server=createServer((req,res)=>{void(async()=>{
  const url=new URL(req.url!,"http://localhost");const chunks:Buffer[]=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks);const input=body.length?JSON.parse(body.toString()):{};
  const json=(value:unknown)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(value));};
  if(url.pathname.startsWith("/v1/")){
   const id=crypto.randomUUID();const response=new Promise<any>(resolve=>replies.set(id,resolve));pending.push({id,path:url.pathname+url.search,method:req.method,headers:req.headers,body:body.toString()});const reply=await response;
   res.writeHead(reply.status,reply.headers);res.end(Buffer.from(reply.body,"base64"));return;
  }
  if(url.pathname==="/pending"){json(pending.splice(0));return;}
  if(url.pathname==="/reply"){replies.get(input.id)?.(input);replies.delete(input.id);json({});return;}
  if(url.pathname==="/status"){json({pid:child?.pid,exited,publications,observations,root,generation});return;}
  if(url.pathname==="/stop"){await stop();json({});return;}
  if(url.pathname==="/provision"){
   config=input;generation++;mounts=input.mounts;
   await mkdir(join(root,"runtime-"+generation,".tmp"),{recursive:true});
   sandbox=new LocalSubprocessSandbox({workdir:join(root,"runtime-"+generation),memoryRoot:join(root,"memory-"+generation),outputsRoot:join(root,"outputs-"+generation)});
   for(const m of mounts){
    const prefix=m.prefix.replace(/^\/+|\/+$/g,"");
    const backing=m.path==="/mnt/session/outputs"?join(root,"outputs-"+generation,"default",input.sessionId):join(root,"memory-"+generation,prefix);
    for(const file of m.files){const path=join(backing,file.name);await mkdir(join(path,".."),{recursive:true});await writeFile(path,Buffer.from(file.bytes,"base64"));}
    if(m.path==="/mnt/session/outputs")await sandbox.mountSessionOutputs({tenantId:"default",sessionId:input.sessionId});
    else await sandbox.mountMemoryStore({storeId:prefix,storeName:m.path.split("/").at(-1),readOnly:m.readOnly});
    // Native mount roots are directories, not the LocalSubprocess symlink
    // projections. Preserve the real read-only bits and copy their directory
    // into this fixture namespace; production O_NOFOLLOW/fsync stays intact.
    const mountPath=join(root,"runtime-"+generation,".mnt",m.path.slice("/mnt/".length));
    const target=readlinkSync(mountPath);unlinkSync(mountPath);cpSync(target,mountPath,{recursive:true,dereference:true});
   }
   json({workspace:join(root,"runtime-"+generation)});return;
  }
  if(url.pathname==="/dump"){
   const files:any[]=[];
   for(const m of mounts){const physical=join(root,"runtime-"+generation,".mnt",m.path.slice("/mnt/".length));
    async function walk(dir:string,relative=""){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isDirectory())await walk(join(dir,entry.name),relative+entry.name+"/");else if(entry.isFile())files.push({mount:m.path,name:relative+entry.name,bytes:(await readFile(join(dir,entry.name))).toString("base64")});}}
    await walk(physical);
   }json(files);return;
  }
  if(url.pathname==="/start"){
   const childConfig={...input,agent,io:origin,workspace:join(root,"runtime-"+generation),agentSettings:{...input.agentSettings,io:origin}};
   child=fork(supervisor,[],{stdio:["ignore","pipe","pipe","ipc"],env:{...process.env,RESOURCE_CHILD_FIXTURE:JSON.stringify(childConfig)}});exited=false;
   child.once("exit",code=>{exited=true;observations.push({type:"exit",code});});child.on("message",(m:any)=>{if(m.type==="published")publications.push(m);else if(m.type==="failed")observations.push(m);});
   child.stdout!.on("data",()=>{});child.stderr!.on("data",b=>observations.push({type:"stderr",text:String(b)}));
   const stat=await readFile(`/proc/${child.pid}/stat`,"utf8");const startTicks=stat.slice(stat.lastIndexOf(")")+2).split(" ")[19];json({pid:child.pid,startTicks});return;
  }
  if(url.pathname==="/discard"){
   if(!/^local-[a-f0-9-]+$/.test(input.id))throw Error("Unknown local snapshot");
   await readFile(join(root,input.id+".tar.zst"));discarded.add(input.id);observations.push({type:"snapshot_discard",id:input.id});json({});return;
  }
  if(url.pathname==="/restore"){
   if(discarded.has(input.id))throw Error("Snapshot discarded");
   if(!/^local-[a-f0-9-]+$/.test(input.id))throw Error("Unknown local snapshot");
   const bytes=await readFile(join(root,input.id+".tar.zst"));
   if(input.sha256!==undefined&&(input.size!==bytes.length||input.sha256!==createHash("sha256").update(bytes).digest("hex")))throw Error("Snapshot integrity mismatch");
   const tar=join(root,input.id+"-restore.tar");await writeFile(tar,zstdDecompressSync(bytes));
   execFileSync("tar",["-xf",tar,"-C",join(root,"runtime-"+generation)]);json({});return;
  }
  if(url.pathname==="/checkpoint"){
   const tar=join(root,"checkpoint-"+crypto.randomUUID()+".tar");execFileSync("tar",["--exclude=./.mnt","--exclude=./.openma/read-only-memory","-cf",tar,"-C",join(root,"runtime-"+generation),"."]);
   const bytes=zstdCompressSync(await readFile(tar));const id="local-"+crypto.randomUUID();await writeFile(join(root,id+".tar.zst"),bytes);
   json({allocationId:id,backup:{id,dir:"/workspace",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),format:"tar+zstd/1"}});return;
  }
  if(url.pathname==="/tool"){
   const result=parseExecResult(await execute(input.command));const observation={id:input.id,output:(input.id==="skill-read"||input.id.startsWith("recall-"))&&result.exitCode===0?Buffer.from(result.stdout,"base64").toString("utf8"):result.stdout+result.stderr,error:result.exitCode!==0};observations.push({...observation,agentPid:input.agentPid});json(observation);return;
  }
  if(url.pathname==="/io"){
   const args=input.args;
   if(input.method==="exec"){json({result:await execute(args[0])});return;}
   const path=namespace(args[0]);
   if(input.method==="readFileBytes"){json({result:(await readFile(path)).toString("base64")});return;}
   if(input.method==="readFile"){json({result:await readFile(path,"utf8")});return;}
   if(input.method==="writeFileBytes"||input.method==="writeFile"){
    await mkdir(join(path,".."),{recursive:true});await writeFile(path,input.method==="writeFileBytes"?Buffer.from(args[1],"base64"):args[1]);json({result:"ok"});return;
   }
   throw Error("Unknown IO");
  }
  res.writeHead(404).end();
 })().catch(e=>{res.writeHead(500,{"content-type":"application/json"}).end(JSON.stringify({error:String(e)}));});});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));server.unref();const origin="http://127.0.0.1:"+(server.address() as any).port;
 live.push(async()=>{await stop();await sandbox?.destroy();await new Promise<void>(r=>server.close(()=>r()));});
 return {origin,root};
}
