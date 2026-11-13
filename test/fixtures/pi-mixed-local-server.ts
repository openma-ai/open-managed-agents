// Loopback-only test peer. The accepted shell programs are fixed here;
// tests cannot use this service to execute arbitrary commands.
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, appendFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const MIXED_BASH = "printf x >> bash-effect.txt; cat bash-effect.txt";
export const RECOVERY_BASH = "printf y >> bash-effect.txt; cat bash-effect.txt";
export async function startPiMixedPeer(port: number) {
  const root=await mkdtemp(join(tmpdir(),"cf-pi-peer-"));
  const server=createServer((req,res)=>{void (async()=>{
    const [id,route]=new URL(req.url!,"http://localhost").pathname.slice(1).split("/");
    if(!/^[a-zA-Z0-9_-]+$/.test(id??"")) {res.writeHead(400).end();return;}
    const dir=join(root,id);await mkdir(dir,{recursive:true});
    const json=(body:unknown)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(body));};
    if(route==="effects") {json({bash:await readFile(join(dir,"bash-effect.txt"),"utf8").catch(()=>""),mcp:await readFile(join(dir,"mcp-effect.txt"),"utf8").catch(()=>"")});return;}
    if(req.method!=="POST"){res.writeHead(405).end();return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    if(route==="bash") {
      if(input.command!==MIXED_BASH&&input.command!==RECOVERY_BASH){res.writeHead(400).end("unexpected program");return;}
      const result=await promisify(execFile)("/bin/bash",["-c",input.command],{cwd:dir,timeout:5000,env:{PATH:"/usr/bin:/bin"}});
      json({stdout:result.stdout,stderr:result.stderr,exitCode:0});return;
    }
    if(route!=="mcp"){res.writeHead(404).end();return;}
    if(input.id===undefined){res.writeHead(202).end();return;}
    let result;
    if(input.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"pi-mixed-peer",version:"1"}};
    else if(input.method==="tools/list")result={tools:[{name:"effect",description:"append one effect",inputSchema:{type:"object",properties:{}}}]};
    else if(input.method==="tools/call"&&input.params.name==="effect"){await appendFile(join(dir,"mcp-effect.txt"),"x");result={content:[{type:"text",text:"effect committed"}]};}
    else {res.writeHead(400).end();return;}
    json({jsonrpc:"2.0",id:input.id,result});
  })().catch(()=>{res.writeHead(500).end("fixture failure");});});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",resolve);});server.unref();
  return async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await rm(root,{recursive:true,force:true});};
}
