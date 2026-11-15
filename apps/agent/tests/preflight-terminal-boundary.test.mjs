// Supplementary source-shape guard only; not behavioral acceptance.
// Real preflight and provider/job continuation gates live in test/integration/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const isVitest=Boolean(globalThis.__vitest_worker__)||Boolean(process.env.VITEST);
const { test }=await import(isVitest?"vitest":"node:test");
let source="";
try { source=readFileSync(join(process.cwd(),"apps/agent/src/runtime/session-do.ts"),"utf8"); } catch {}
const sourceShapeTest = isVitest ? { skip: "source-shape checks run in the Node architecture harness" } : {};
test("the general execution boundary cannot emit idle for a sandbox/tool job failure",sourceShapeTest,()=>{
 const run=source.slice(source.indexOf("private async runLaneExecution("),source.indexOf("private async runLaneExecution(")+12000);
 const generalCatch=run.slice(run.indexOf("} catch (err) {"),run.indexOf("} finally {"));
 assert.ok(generalCatch.includes("turnFailed = true"));
 assert.doesNotMatch(generalCatch,/session\.status_idle|retries_exhausted/);
});
test("preflight terminal handling is confined to warmup before harness construction",sourceShapeTest,()=>{
 const process=source.slice(source.indexOf("private async processUserMessage("));
 const beforeHarness=process.slice(0,process.indexOf("// Resolve harness via registry"));
 assert.match(beforeHarness,/try \{\s*await this\.warmUpSandbox\(\);\s*\} catch \(err\)/);
 assert.match(beforeHarness,/history\.append\(idleEvent\); this\.broadcastEvent\(idleEvent, activeFence\)/);
 assert.match(beforeHarness,/!hasOpenExecutionCall\(history.getEvents\(\), turnThreadId\)/);
 assert.doesNotMatch(beforeHarness,/harness\.run|portsSandbox\.endExecution/);
});
