import {expect,it} from "vitest";
import {NodeManagedAcpStartupConfigurationFailure} from "../src/work-item-failure";
import {workStartupFailureEvents} from "../../managed-agents-application/src/session-execution/work-startup-failure";
const claim={workspaceId:"w",environmentId:"e",sessionId:"s",workId:"work",generation:1};
it.each(["model_unavailable","anthropic_protocol_required"] as const)("typed startup %s preserves only fixed safe diagnostics",reason=>{
 const failure=new NodeManagedAcpStartupConfigurationFailure(reason,new Error("api-key-secret"));
 expect(failure.phase).toBe("startup");expect(failure.message).not.toContain("api-key-secret");
 const events=workStartupFailureEvents({claim,revision:2,processedAt:"2026-11-11T00:00:00Z",reason});
 expect(JSON.stringify(events)).toContain(reason==="model_unavailable"?"active workspace model card":"requires [anthropic-messages]");
 expect(JSON.stringify(events)).not.toContain("api-key-secret");
});

it("startup route accepts only reason codes, not raw error payloads",async()=>{
 const {buildWorkStartupFailureRoutes}=await import("../../http-routes/src/work-startup-failure");
 const writes:unknown[]=[];
 const routes=buildWorkStartupFailureRoutes({authenticate:async()=>claim,persistenceFor:async()=>({captureStartupBoundary:async()=>2,settleStartupFailure:async input=>{writes.push(input);return "committed";}})});
 const send=(body:object)=>routes.request("/s/startup-failed",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({revision:2,processedAt:"2026-11-11T00:00:00Z",...body})});
 expect((await send({reason:"model_unavailable"})).status).toBe(200);
 for(const body of [{reason:"secret-token"},{reason:["model_unavailable"]},{reason:{type:"model_unavailable"}},{reason:"model_unavailable",message:"secret-token"},{cause:"secret-token"}])expect((await send(body)).status).toBe(400);
 expect(writes).toHaveLength(1);
});
