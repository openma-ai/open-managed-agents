import { expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { dispatchCfWorkRunnerRequest } from "../src/runtime/cf-work-runner-entry";
const delivery={workspaceId:"ws",environmentId:"env",sessionId:"sess",workId:"work",apiBaseUrl:"https://control.test",workSecret:"secret"};
const request=()=>new Request("https://internal/__internal/work/dispatch",{method:"POST",body:JSON.stringify(delivery)});
it("E2B automatic dispatch uses the existing workspace/session DO without requiring a CF runner command",async()=>{
 const names:string[]=[];const requests:Request[]=[];
 const env={SANDBOX_ADAPTER:"e2b",PUBLIC_BASE_URL:"https://control.test",PLATFORM_ROOT_SECRET:"root",SESSION_DO:{idFromName(name:string){names.push(name);return name;},get(){return {async fetch(req:Request){requests.push(req);return Response.json({created:true});}};}}};
 const response=await dispatchCfWorkRunnerRequest(request(),env as never);
 expect(response.status).toBe(200);expect(names).toEqual(['["ws","sess"]']);expect(requests).toHaveLength(1);
 expect(new URL(requests[0].url).pathname).toBe("/__internal/work/dispatch");expect(await requests[0].json()).toEqual(delivery);
});
it("uninitialized SessionDO recognizes the private Work route and fails closed before any provider", async () => {
 const stub=env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["ws","sess"])));
 const response=await stub.fetch(request());
 expect(response.status).toBe(503);
 expect(await response.json()).toEqual({error:"Work bootstrap is not configured"});
});
it("unknown provider is rejected before any sandbox or authority mutation",async()=>{
 const response=await dispatchCfWorkRunnerRequest(request(),{SANDBOX_ADAPTER:"typo",PUBLIC_BASE_URL:"https://control.test",PLATFORM_ROOT_SECRET:"root",OPENMA_WORK_RUNNER_COMMAND:"/installed"} as never);
 expect(response.status).toBe(503);
});
