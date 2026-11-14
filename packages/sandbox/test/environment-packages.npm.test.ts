import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {expect,it} from "vitest";
import {ensureEnvironmentPackages,type PackageSandbox} from "../src/environment-packages";

it.each([
  {name:"partial missing",installed:["present-pkg"],requested:["present-pkg","absent-pkg"],want:"fresh"},
  {name:"all missing",installed:[],requested:["present-pkg","absent-pkg"],want:"fresh"},
  {name:"version mismatch",installed:["present-pkg"],requested:["present-pkg@2.0.0"],want:"fresh"},
  {name:"all installed",installed:["present-pkg","absent-pkg"],requested:["present-pkg@^1.0.0","absent-pkg@1.0.0"],want:"warm"},
])("checks every declaration using real npm: $name",async ({installed,requested,want})=>{
 const root=mkdtempSync(join(tmpdir(),"oma-npm-fixture-"));
 try{
  for(const name of installed){const dir=join(root,"lib/node_modules",name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"package.json"),JSON.stringify({name,version:"1.0.0"}));}
  let warm="MISSING",rest="MISSING",setups=0;
  const sandbox:PackageSandbox={async exec(command){
   if(command.startsWith("WARM="))return "WARM="+warm+"\nREST="+rest;
   if(command.startsWith("npm ls ")){const r=spawnSync("/bin/sh",["-c",command.replaceAll("/workspace/.npm-global",root)],{encoding:"utf8"});return "exit="+r.status+"\n"+r.stdout+"\nstderr: "+r.stderr;}
   if(command.startsWith("(\nset -e")){setups++;return "exit=0\n";}
   warm=command.match(/echo "([^"]+)" > \/tmp\/\.oma-setup-warm/)?.[1]??warm;
   rest=command.match(/echo "([^"]+)" > \/workspace\/\.oma-setup-restored/)?.[1]??rest;
   return "exit=0\n";
  }};
  await ensureEnvironmentPackages(sandbox,{npm:requested});
  const result=await ensureEnvironmentPackages(sandbox,{npm:requested});
  expect(result.path).toBe(want);
  expect(setups).toBe(want==="warm"?1:2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
