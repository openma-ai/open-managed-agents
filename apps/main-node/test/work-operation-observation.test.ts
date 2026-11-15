import { expect, it } from "vitest";
import { observeWorkOperation, type WorkOperationObservation } from "../../../packages/control-plane-node/src/lib/work-operation-observation";
const scope = {workspaceId:"workspace",environmentId:"environment",sessionId:"session",workId:"work",generation:3};
it("records exact claim and lifecycle without serializing a sensitive failure", async () => {
 const events: WorkOperationObservation[]=[];
 const secret=new Error("credential-canary");
 await expect(observeWorkOperation(e=>events.push(e),scope,"native-start",async()=>{throw secret;})).rejects.toBe(secret);
 expect(events.map(e=>e.status)).toEqual(["started","failed"]);
 expect(events.every(e=>e.workId==="work"&&e.generation===3&&e.durationMs>=0)).toBe(true);
 expect(JSON.stringify(events)).not.toContain("credential-canary");
});
it("preserves success and original failure when telemetry throws", async () => {
 const emit=()=>{throw Error("telemetry unavailable");};
 await expect(observeWorkOperation(emit,scope,"checkpoint-restore",async()=>42)).resolves.toBe(42);
 const failure=Error("operation failed");
 await expect(observeWorkOperation(emit,scope,"checkpoint-restore",async()=>{throw failure;})).rejects.toBe(failure);
});
