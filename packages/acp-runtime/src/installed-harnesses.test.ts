import {expect,it} from "vitest";
import {parseInstalledHarnesses} from "./installed-harnesses";
const valid={id:"codex-acp",version:"1.2.3-beta.1+build.4",command:"/opt/openma/bin/codex-acp",args:["--stdio","two words"]};
it("returns an isolated pinned inventory without Node, network or registry resolution",()=>{
 expect(parseInstalledHarnesses(undefined)).toBeNull();expect(parseInstalledHarnesses("[]")).toEqual([]);
 expect(parseInstalledHarnesses(JSON.stringify([valid]))).toEqual([valid]);
});
it.each(["latest","next","main","^1.2.3","~1.2.3","1.x","*",">=1","1a2"])("rejects floating/nonexact version %s",version=>{
 expect(()=>parseInstalledHarnesses(JSON.stringify([{...valid,version}]))).toThrow();
});
it("rejects duplicate identity before any consumer selects the first match",()=>{
 expect(()=>parseInstalledHarnesses(JSON.stringify([valid,{...valid,command:"/other"}]))).toThrow(/duplicate/);
});
it.each(["relative","/opt/../bin/runner","/opt/./runner","/opt/runner;bad","/opt/runner\0","/opt/runner\n"])("rejects invalid command %s",command=>{
 expect(()=>parseInstalledHarnesses(JSON.stringify([{...valid,command}]))).toThrow();
});
it.each([["ok",3],["bad\0arg"],"not-array"])("rejects invalid argv %#",args=>{
 expect(()=>parseInstalledHarnesses(JSON.stringify([{...valid,args}]))).toThrow();
});
it.each([null,{},[null],[{...valid,id:" leading"}]])("rejects malformed inventory %#",value=>{
 expect(()=>parseInstalledHarnesses(JSON.stringify(value))).toThrow();
});
