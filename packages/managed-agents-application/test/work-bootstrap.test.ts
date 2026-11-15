import { expect, it } from "vitest";
import * as application from "../src/index";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
const claim={workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"owner"};
function row(id:string,revision:number,extra:Record<string,unknown>={},source:Record<string,unknown>={}) {
 const document=JSON.stringify({id,type:"user.message",content:[],processedAt:null,...extra,source_position:{revision,index:0,...source}});
 return {document,decoded:decodeSessionEventDocument(document)};
}
const consumed=(id:string,rev:number)=>row(id,rev,{processedAt:"2026-11-10T00:00:00Z"},{consumed_by_execution_id:id});
const terminal=(id:string,rev:number,turn:string,stopReason:object={type:"end_turn"})=>row(id,rev,{type:"session.status_idle",stopReason},{execution_id:turn,environment_work:{workId:"w",generation:1}});
const plan=(rows:ReturnType<typeof row>[],budgetExhausted=false)=>{
 expect(typeof application.planWorkBootstrap).toBe("function");
 return application.planWorkBootstrap({claim,revision:20,rows,budgetExhausted});
};
it("selects the first canonical pending input rather than newest input or idle",()=>{
 expect(plan([row("later",3),row("first",2)])).toMatchObject({type:"run",root:{inputId:"first",turnId:"first",position:{revision:2,index:0}}});
});
it("never skips an unknown consumed root even when a newer root has a terminal",()=>{
 expect(plan([consumed("unknown",2),consumed("new",3),terminal("idle",4,"new"),row("next",5)])).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal",root:{turnId:"unknown"}});
});
it("retains original consumed root across absorbed input",()=>{
 expect(plan([consumed("root",2),row("answer",3,{processedAt:"2026-11-10T00:00:00Z"},{consumed_by_execution_id:"root",execution_id:"answer-dispatch"})])).toMatchObject({type:"gap",root:{turnId:"root"}});
});
it("returns completed exact root receipt with its source generation",()=>{
 expect(plan([consumed("root",2),terminal("idle",3,"root")])).toMatchObject({type:"cleanup-only",root:{turnId:"root"},terminal:{eventId:"idle",generation:1}});
});
it("allows successor after a proven completed root, not by inferring idle",()=>{
 expect(plan([consumed("root",2),terminal("idle",3,"root"),row("next",4)])).toMatchObject({type:"run",root:{turnId:"next"}});
});
it("no actionable input is idle, and system/control events do not fabricate a prompt",()=>{
 expect(plan([])).toEqual({type:"idle",root:null});
 expect(plan([row("system",2,{type:"system.message"}),row("control",3,{type:"session.updated"})])).toEqual({type:"idle",root:null});
});
it("partial answer remains parked; complete answers select continuation before queued message",()=>{
 const root=consumed("root",2), stop=terminal("idle",3,"root",{type:"requires_action",eventIds:["a","b"]});
 const a=row("answer-a",5,{type:"user.custom_tool_result",customToolUseId:"a"});
 expect(plan([root,stop,row("queued",4),a])).toMatchObject({type:"parked",root:{turnId:"root"}});
 expect(plan([root,stop,row("queued",4),a,row("answer-b",6,{type:"user.custom_tool_result",customToolUseId:"b"})])).toMatchObject({type:"run",root:{turnId:"answer-a"}});
});
it("respects exhausted hold and budget gating",()=>{
 expect(plan([consumed("root",2),row("held",3),terminal("idle",4,"root",{type:"retries_exhausted"})])).toMatchObject({type:"cleanup-only",root:{turnId:"root"}});
 expect(plan([consumed("root",2),terminal("idle",3,"root",{type:"budget_reached"}),row("resume",4,{type:"session.updated",resume:true})],true)).toMatchObject({type:"parked"});
});
it("invalid source positions and orphan consumption fail closed even on empty actionable stream",()=>{
 expect(plan([row("a",2),row("b",2)])).toMatchObject({type:"gap",reason:"canonical_position_collision"});
 expect(plan([row("child",2,{}, {consumed_by_execution_id:"missing"})])).toMatchObject({type:"gap",reason:"canonical_consuming_root_missing"});
 const bad=row("system",2,{type:"system.message"});delete bad.decoded.position;
 expect(plan([bad])).toMatchObject({type:"gap",reason:"canonical_position_required"});
});
it("candidate selection never grants authority without finalization inspection and final revision fence",async()=>{
 expect(typeof application.WorkBootstrapApplication).toBe("function");
 const snapshot={type:"snapshot" as const,revision:20,rows:[row("first",2)],budgetExhausted:false};
 const app=new application.WorkBootstrapApplication({persistence:{read:async()=>snapshot,isCurrent:async()=>false},finalization:{inspect:async()=>({type:"current",revision:20,consumed:false,terminal:null})}});
 expect(await app.read(claim)).toEqual({type:"rejected",reason:"authority_changed"});
 const refused=new application.WorkBootstrapApplication({persistence:{read:async()=>snapshot,isCurrent:async()=>true},finalization:{inspect:async()=>({type:"rejected",reason:"newer_input"})}});
 expect(await refused.read(claim)).toMatchObject({type:"gap",reason:"finalization_newer_input",root:{turnId:"first"},revision:20});
});
it("does not swallow unattached terminal or duplicate source identity into resident idle",()=>{
 expect(plan([terminal("orphan",3,"missing")])).toMatchObject({type:"gap",reason:"canonical_terminal_root_missing"});
 expect(plan([row("same",2),row("same",3)])).toMatchObject({type:"rejected",reason:"canonical_turn"});
});
it("bootstrap initial identity validation applies even to non-runnable rows",()=>{
 const bad={...row("invented",1,{type:"system.message"}),sequence:0};
 expect(plan([bad])).toMatchObject({type:"gap",reason:"bootstrap_identity"});
});

it("admits followup without replaying a consumed root explicitly interrupted on a previous Work",()=>{
 const root=row("old",2,{processedAt:"2026-11-10T00:00:00Z"},{consumed_by_execution_id:"old",consumption_claim:{workId:"previous",generation:1,holder:"old-owner"}});
 const interrupt=row("interrupt",4,{type:"user.interrupt",environmentWorkId:"previous"});
 expect(plan([root,interrupt,row("next",5)])).toMatchObject({type:"run",root:{turnId:"next"}});
 expect(plan([root,interrupt])).toEqual({type:"idle",root:null});
});
it.each(["same-work","wrong-target","wrong-lane","before-root","missing-claim"])("does not erase an unknown consumed root for %s interrupt",mode=>{
 const root=row("old",2,{processedAt:"2026-11-10T00:00:00Z"},{consumed_by_execution_id:"old",...(mode==="missing-claim"?{}:{consumption_claim:{workId:mode==="same-work"?"w":"previous",generation:1,holder:"old-owner"}})});
 const interrupt=row("interrupt",mode==="before-root"?1:4,{type:"user.interrupt",environmentWorkId:mode==="wrong-target"?"other":mode==="same-work"?"w":"previous",...(mode==="wrong-lane"?{sessionThreadId:"child"}:{})});
 expect(plan([root,interrupt,row("next",5)])).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal"});
});
