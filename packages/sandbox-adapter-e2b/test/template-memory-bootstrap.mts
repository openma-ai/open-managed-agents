/** Explicit isolated provider gate, never auto-provisions from unit-test CI.
 * E2B_API_KEY + OMA_E2B_TEMPLATE required. Uses one NEW owned sandbox only.
 * Exercises the official image bootstrap command, not a published new image.
 */
import { writeFileSync } from "node:fs";
import { Sandbox } from "../../../apps/main-node/node_modules/e2b/dist/index.mjs";
import { E2BSandboxExecutor } from "../src/e2b";
import { prepareMemoryRoot } from "../template/template.mjs";
import { createSandboxSessionMemoryFilePort } from "../../managed-runtime-sandbox/src/session-memory-workspace";
import assert from "node:assert/strict";
const apiKey=process.env.E2B_API_KEY,template=process.env.OMA_E2B_TEMPLATE,output=process.env.OMA_E2B_MEMORY_RECEIPT;
if(!apiKey||!template||!output)throw Error("E2B_API_KEY, OMA_E2B_TEMPLATE, OMA_E2B_MEMORY_RECEIPT required");
const receipt:any={kind:"new isolated provider UID/bootstrap/file-materialization gate; NOT rebuilt-template or R2 publication acceptance",template,startedAt:new Date().toISOString()};
let box:Sandbox|undefined;
const save=()=>writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");save();
try{
 box=await Sandbox.create(template,{apiKey,timeoutMs:120000,metadata:{task:"pr545-task-e2e4t-20261112",purpose:"isolated-official-memory-bootstrap-gate"}});receipt.sandboxId=box.sandboxId;save();
 const executor=new E2BSandboxExecutor(box as never,{managedBootstrap:{}});
 const files=createSandboxSessionMemoryFilePort(executor);const signal=new AbortController().signal;
 receipt.identity=await executor.exec("id; stat -c '%n uid=%u gid=%g mode=%a' /mnt /workspace");
 let rejected=false;
 try{await files.replace("/mnt/memory/gate",new Map([["note.txt","bytes"]]),signal,{readOnly:false});}
 catch(error){assert.equal((error as Error).name,"SessionMemoryRootNotWritableError");rejected=true;receipt.before={name:(error as Error).name,message:(error as Error).message};}
 assert.equal(rejected,true,"old template must reproduce unprivileged preparation rejection");save();
 // Fresh validation allocation only. This is the exact official image command;
 // never retrofit a Session sandbox or change SDK/tool identity to root.
 receipt.bootstrapCommand=prepareMemoryRoot;
 const bootstrap=await box.commands.run(prepareMemoryRoot,{user:"root",timeoutMs:10000});assert.equal(bootstrap.exitCode,0);
 receipt.ownership=await executor.exec("id; stat -c '%n uid=%u gid=%g mode=%a' /mnt/memory; test ! -r /opt/oma-managed/installation.json");
 await files.replace("/mnt/memory/gate",new Map([["note.txt","provider-real-memory-bytes"]]),signal,{readOnly:false});
 assert.equal(await files.read("/mnt/memory/gate/note.txt",signal),"provider-real-memory-bytes");
 await files.replace("/mnt/memory/readonly",new Map([["note.txt","protected"]]),signal,{readOnly:true});
 const denied=await executor.run("printf forbidden > /mnt/memory/readonly/note.txt");assert.notEqual(denied.exitCode,0);
 assert.equal(await files.read("/mnt/memory/readonly/note.txt",signal),"protected");
 receipt.status="PASS_BOOTSTRAP_COMMAND_ONLY";receipt.checks={beforeHarnessReject:true,workerWriteRead:true,readOnlyReject:true,managementPrivate:true};
}catch(error){receipt.status="FAIL";receipt.error={name:(error as Error).name,message:String((error as Error).message).split(apiKey).join("[REDACTED]")};process.exitCode=1;}
finally{if(box){try{receipt.paused=await box.betaPause();}catch(error){receipt.pauseError=String((error as Error).message).split(apiKey).join("[REDACTED]");}}receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:receipt.status,sandboxId:receipt.sandboxId,paused:receipt.paused}));}
