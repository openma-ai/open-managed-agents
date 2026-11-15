import { expect,it } from "vitest";
import { readFile,cp,mkdtemp,rm,mkdir } from "node:fs/promises";
import { fileURLToPath,URL } from "node:url";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
const root=fileURLToPath(new URL("../../../",import.meta.url));
it("0034 has a fresh identity and Drizzle can check and generate its successor",async()=>{
 const base=join(root,"apps/main-node/migrations-sqlite");
 const previous=JSON.parse(await readFile(join(base,"meta/0033_snapshot.json"),"utf8"));
 const current=JSON.parse(await readFile(join(base,"meta/0034_snapshot.json"),"utf8"));
 expect(current.id).not.toBe(previous.id);expect(current.prevId).toBe(previous.id);
 await mkdir(join(root,".validation/work-inputs/review-fixes"),{recursive:true});
 const tmp=await mkdtemp(join(root,".validation/work-inputs/review-fixes/snapshot-test-"));
 try{
  await cp(base,join(tmp,"migrations"),{recursive:true});
  const cli=join(root,"node_modules/drizzle-kit/bin.cjs");
  const run=spawnSync(process.execPath,[cli,"generate","--dialect","sqlite","--schema","./packages/db-schema/src/node-sqlite/index.ts","--out",relative(root,join(tmp,"migrations"))],{cwd:root,encoding:"utf8"});
  const result=run.stdout+run.stderr;
  expect(run.status,result).toBe(0);
  expect(result).not.toMatch(/collision|Error:|error:/i);
  expect(result).toMatch(/No schema changes|SQL migration file/);
  expect(await readFile(join(tmp,"migrations/meta/0034_snapshot.json"),"utf8")).toBe(await readFile(join(base,"meta/0034_snapshot.json"),"utf8"));
 }finally{await rm(tmp,{recursive:true,force:true});}
});
