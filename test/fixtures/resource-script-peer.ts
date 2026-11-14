// Test-only provider IO bridge. Called only by an agent-issued bash operation.
// The fixed uploaded script is executed, never replaced with expected output.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAKE_REPORT_SH } from "../resource-convergence/resource-agent-fixture";
export async function executeResourceScript(dir: string, input: { script: string; seed: string; correctContext: boolean }) {
  if (input.script !== MAKE_REPORT_SH) throw Error("Unexpected fixture script bytes");
  const skill=join(dir,"skill");await mkdir(join(skill,"scripts"),{recursive:true});await mkdir(join(skill,"data"),{recursive:true});
  await writeFile(join(skill,"scripts/make-report.sh"),input.script);await writeFile(join(skill,"data/seed.txt"),Buffer.from(input.seed,"base64"));
  const output=join(dir,"produced-report.txt");
  try {
    const result=await promisify(execFile)("/bin/sh",["scripts/make-report.sh",output],{cwd:input.correctContext?skill:dir,timeout:5000,env:{PATH:"/usr/bin:/bin"}});
    return {...result,exitCode:0,bytes:(await readFile(output)).toString("base64")};
  } catch(error) {const failure=error as {code?:number;stdout?:string;stderr?:string};return {exitCode:failure.code??1,stdout:failure.stdout??"",stderr:failure.stderr??"",bytes:null};}
}
