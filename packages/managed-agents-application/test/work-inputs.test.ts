import { expect, it } from "vitest";
import { WorkInputsApplication } from "../src/session-execution/work-inputs";
const claim={workspaceId:"ws",sessionId:"s",environmentId:"env",workId:"w",generation:2,holder:"holder"};
const row=(id:string,revision:number,index:number)=>({event:{id,type:"user.message",processedAt:null,content:[]},position:{revision,index},document:id});
it("encodes exclusive cursor, preserves empty tail, and does not bind cursor to attempts",async()=>{
  const calls:unknown[]=[];
  const store={read:async(input:unknown)=>{calls.push(input);return calls.length===1 ? {type:"page" as const,rows:[row("z",2,0),row("a",2,1)],hasMore:true} : {type:"page" as const,rows:[],hasMore:false};},consume:async()=>({type:"rejected" as const})};
  const app=new WorkInputsApplication(store);
  const first=await app.read({claim,cursor:null,limit:2});
  expect(first.type).toBe("page");if(first.type!=="page")throw Error("page");
  expect(typeof first.cursor).toBe("string");expect(first.cursor).not.toContain("revision");
  const tail=await app.read({claim:{...claim,generation:3,holder:"new"},cursor:first.cursor,limit:2});
  expect(tail).toEqual({type:"page",rows:[],cursor:first.cursor,hasMore:false});
  expect(calls[1]).toEqual({claim:{...claim,generation:3,holder:"new"},after:{revision:2,index:1},limit:2});
  expect(await app.read({claim:{...claim,sessionId:"foreign"},cursor:first.cursor,limit:2})).toEqual({type:"invalid",reason:"cursor"});
});
it("rejects malformed cursor and unbounded page sizes before storage",async()=>{
 const app=new WorkInputsApplication({read:async()=>{throw Error("must not read");},consume:async()=>({type:"rejected"})});
 for(const limit of [0,-1,201,NaN,1.1])expect(await app.read({claim,cursor:null,limit})).toEqual({type:"invalid",reason:"limit"});
 for(const cursor of ["","garbage","e30", "x".repeat(9000)])expect(await app.read({claim,cursor,limit:1})).toEqual({type:"invalid",reason:"cursor"});
});
it("propagates prerequisite gaps without manufacturing a cursor",async()=>{
 const app=new WorkInputsApplication({read:async()=>({type:"gap",reason:"source_position_index_required"}),consume:async()=>({type:"rejected"})});
 expect(await app.read({claim,cursor:null,limit:1})).toEqual({type:"gap",reason:"source_position_index_required"});
});
it("refuses non-progressing ordered pages rather than looping or keeping a seen set",async()=>{
 const app=new WorkInputsApplication({read:async()=>({type:"page",rows:[row("a",2,1),row("b",2,0)],hasMore:true}),consume:async()=>({type:"rejected"})});
 expect(await app.read({claim,cursor:null,limit:2})).toEqual({type:"gap",reason:"invalid_ordered_page"});
});
