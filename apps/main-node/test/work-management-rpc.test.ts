import { afterEach, expect, it, vi } from "vitest";
import { callManagementRpc, type ManagementRpcState, type ManagementRpcObservation } from "../../../packages/control-plane-node/src/lib/work-management-rpc";
afterEach(()=>vi.useRealTimers());
it("names the pending operation, retains it on timeout, and observes its late native result",async()=>{
 vi.useFakeTimers();let resolve!:(value:string)=>void;const native=new Promise<string>(r=>{resolve=r;});const state:ManagementRpcState={};const events:ManagementRpcObservation[]=[];const action=vi.fn(()=>native);
 const first=callManagementRpc(state,"kill",action,e=>events.push(e));const rejected=expect(first).rejects.toThrow("native outcome is unknown");await vi.advanceTimersByTimeAsync(1000);await rejected;
 expect(state.pending?.op).toBe("kill");const id=state.pending?.id;
 await expect(callManagementRpc(state,"current",async()=>true,e=>events.push(e))).rejects.toThrow("Previous management RPC outcome is pending");
 const again=callManagementRpc(state,"kill",action,e=>events.push(e));resolve("exited");await expect(again).resolves.toBe("exited");expect(action).toHaveBeenCalledTimes(1);expect(state.pending).toBeUndefined();
 expect(events.map(e=>e.phase)).toEqual(["started","wait_timeout","blocked","completed"]);
 expect(events.every(e=>e.rpcId===id&&e.pendingOperation==="kill")).toBe(true);expect(events[2].requestedOperation).toBe("current");expect(events[3].result).toBe("exited");
});
it("preserves original rejection and does not serialize arbitrary native results or error bodies",async()=>{
 const state:ManagementRpcState={};const events:ManagementRpcObservation[]=[];const error=new Error("PRIVATE_TOKEN");
 await expect(callManagementRpc(state,"status",async()=>{throw error;},e=>events.push(e))).rejects.toBe(error);
 await callManagementRpc(state,"status",async()=>"PRIVATE_CONTENT",e=>events.push(e));
 expect(events.map(e=>e.phase)).toEqual(["started","failed","started","completed"]);expect(JSON.stringify(events)).not.toContain("PRIVATE");
});
it("observer failure cannot change the management result",async()=>{
 await expect(callManagementRpc({},"current",async()=>true,()=>{throw new Error("logger down");})).resolves.toBe(true);
});
