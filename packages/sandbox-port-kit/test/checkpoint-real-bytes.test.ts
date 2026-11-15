import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { sandboxMemoryStoreSync } from "@open-managed-agents/managed-runtime-sandbox";
import type { SessionMemoryAccessPort, SessionMemoryDocument } from "@open-managed-agents/runtime-resource-contract";
import { createSyncStorage, memoryResources } from "../src/sync-storage";
import { v1Vendor } from "../src/v1-bridge";

it("checkpoint writes real Memory bytes without publishing outputs; failed upload retains bytes for retry", async () => {
  const root=await mkdtemp(join(tmpdir(),"oma-checkpoint-bytes-"));
  const sandbox=new LocalSubprocessSandbox({workdir:root});
  const docs=new Map<string,SessionMemoryDocument>();
  const published=new Map<string,Uint8Array>();
  let failMemory=false, failOutputs=false;
  const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
  const memories:SessionMemoryAccessPort={
    list:async()=>[...docs.values()],
    create:async input=>{
      if(failMemory) throw new Error("Memory backend upload refused");
      if(docs.has(input.path)) return {type:"conflict"};
      const memory={id:input.path,path:input.path,content:input.content,contentSha256:hash(input.content)};
      docs.set(input.path,memory); return {type:"applied",memory};
    },
    update:async input=>{
      if(failMemory) throw new Error("Memory backend upload refused");
      if(docs.get(input.path)?.contentSha256!==input.expectedContentSha256) return {type:"conflict"};
      const memory={id:input.memoryId,path:input.path,content:input.content,contentSha256:hash(input.content)};
      docs.set(input.path,memory);return {type:"applied",memory};
    },
    delete:async input=>{const doc=[...docs.values()].find(d=>d.id===input.memoryId);if(!doc)return {type:"not_found"};if(doc.contentSha256!==input.expectedContentSha256)return {type:"conflict"};docs.delete(doc.path);return {type:"applied"};},
  };
  const scope={workspaceId:"ws",environmentId:"env",sessionId:"checkpoint-bytes",workId:"work"};
  const fence={...scope,ownerId:"owner",generation:1,token:"fixture",expiresAt:"2030-01-01T00:00:00Z"};
  const stores=[{storeId:"notes",storeName:"notes",readOnly:false}];
  const signal=new AbortController().signal;
  const storage=createSyncStorage(v1Vendor("local-byte-test"),{memories:()=>memories,authorize:async()=>true,outputs:{
    async *read(){yield* published;},
    async publish({files}){if(failOutputs)throw new Error("Outputs backend upload refused");const next=new Map<string,Uint8Array>();for await(const [p,b] of files)next.set(p,b);published.clear();for(const [p,b] of next)published.set(p,b);},
  }});
  try {
    // Materialize through the real file-sync implementation; this gate concerns
    // checkpoint vs turn-end bytes, not the separate outputs seeding invariant.
    await sandboxMemoryStoreSync(sandbox).materialize({session:{id:scope.sessionId,resources:memoryResources(stores)},resourceOwnership:{memoryStore:"materializer"},access:{memories},authorize:async()=>true,signal});
    await sandbox.exec("mkdir -p /mnt/session/outputs");
    await sandbox.writeFile("/mnt/session/outputs/report.txt","OUTPUT_BYTES");
    await sandbox.writeFile("/mnt/memory/notes/note.txt","MEMORY_BYTES");
    const input={runtime:sandbox,scope,fence,stores,outputs:{bindingId:"files",mountPath:"/mnt/session/outputs" as const},signal};
    failMemory=true;
    await expect(storage.sync({...input,reason:"checkpoint"})).rejects.toThrow("Memory backend upload refused");
    expect(docs.size).toBe(0); expect(published.size).toBe(0);
    expect(await sandbox.readFile("/mnt/memory/notes/note.txt")).toBe("MEMORY_BYTES");
    failMemory=false;
    await storage.sync({...input,reason:"checkpoint"});
    expect(docs.get("/note.txt")?.content).toBe("MEMORY_BYTES");
    expect(docs.get("/note.txt")?.contentSha256).toBe(hash("MEMORY_BYTES"));
    expect(published.size).toBe(0);
    failOutputs=true;
    await expect(storage.sync({...input,reason:"turn_end"})).rejects.toThrow("Outputs backend upload refused");
    expect(published.size).toBe(0);
    expect(await sandbox.readFile("/mnt/session/outputs/report.txt")).toBe("OUTPUT_BYTES");
    failOutputs=false;
    await storage.sync({...input,reason:"turn_end"});
    expect(new TextDecoder().decode(published.get("report.txt"))).toBe("OUTPUT_BYTES");
  } finally {await sandbox.destroy();await rm(root,{recursive:true,force:true});}
},30_000);
