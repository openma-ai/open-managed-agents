import {expect,it} from "vitest";
import {attempt,fakeSessionSandbox,runningRecord} from "./fake-session-sandbox-ports";
const binding={executionId:attempt.executionId,attemptId:attempt.attemptId,ownerId:attempt.ownerId,generation:attempt.generation};
const snapshot={status:"taken" as const,ref:{provider:"fake",ref:"clean",kind:"snapshot" as const}};
it("new execution cannot attach old physical allocation; retires through CAS and restores latest snapshot",async()=>{
 const f=fakeSessionSandbox({isolateExecutionAttempts:true,saved:runningRecord("old",{attemptBinding:{...binding,attemptId:"old"},latestSnapshot:snapshot,pauseRef:{provider:"fake",ref:"old",kind:"self"}}),resumable:["old","clean"]});
 await f.sandbox.runtime();
 expect(f.log).not.toContain("resume:old");
 expect(f.log).not.toContain("attach:old");expect(f.log).toContain("release:old");expect(f.log).toContain("resume:clean");
 expect(f.stored()).toMatchObject({phase:"running",handle:{runtimeId:"from-clean"},attemptBinding:binding,retiredHandles:[{handle:{runtimeId:"old"},released:true}]});
});
it("same attempt reconnect reuses physical sandbox without release",async()=>{
 const f=fakeSessionSandbox({isolateExecutionAttempts:true,saved:runningRecord("old",{attemptBinding:binding})});await f.sandbox.runtime();await f.sandbox.prepare();
 expect(f.log.filter(x=>x==="attach:old")).toHaveLength(2);expect(f.log.some(x=>x.startsWith("release:"))).toBe(false);
});
it("a cached runtime cannot bypass isolation when rebound to a new attempt",async()=>{
 const f=fakeSessionSandbox({isolateExecutionAttempts:true,saved:runningRecord("old",{attemptBinding:binding,latestSnapshot:snapshot}),resumable:["clean"]});await f.sandbox.runtime();f.log.length=0;
 f.setExecution({...attempt,attemptId:"new",generation:4});await f.sandbox.runtime();expect(f.log).toContain("release:old");expect(f.log).toContain("resume:clean");
});
it("unknown previous attempt without snapshot fails visibly instead of recreating empty",async()=>{
 const f=fakeSessionSandbox({isolateExecutionAttempts:true,saved:runningRecord("old")});await expect(f.sandbox.runtime()).rejects.toThrow(/snapshot/);expect(f.log).not.toContain("attach:old");expect(f.log).not.toContain("acquire");
});
it("lost authority or lookup unavailable cannot retire or attach old allocation",async()=>{
 const f=fakeSessionSandbox({isolateExecutionAttempts:true,saved:runningRecord("old",{attemptBinding:{...binding,attemptId:"old"},latestSnapshot:snapshot})});f.loseFence();await expect(f.sandbox.runtime()).rejects.toThrow();expect(f.log).toEqual([]);
});
it("a pristine warmed allocation is claimed once without destruction",async()=>{
 const f=fakeSessionSandbox({isolateExecutionAttempts:true});f.setExecution(undefined);await f.sandbox.warm();f.setExecution(attempt);await f.sandbox.runtime();expect(f.log).not.toContain("release:r1");expect(f.stored()).toMatchObject({attemptBinding:binding});
});
