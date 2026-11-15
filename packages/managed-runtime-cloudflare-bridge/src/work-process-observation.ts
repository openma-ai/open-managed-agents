/** Wire-only observer contract. No restore/start port: a provider which has no
 * trusted Work-bound native slot MUST answer unknown, not infer from /running. */
export interface WorkProcessScope {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  generation: number;
  holder: string;
}
export interface WorkProcessObservation {
  status: "running";
  runtimeId: string;
  process: { id: string; epoch: string; pid: number; startTicks: string };
  work: WorkProcessScope & { attemptId: string };
}
export const workProcessScopeKeys = ["workspaceId", "environmentId", "sessionId", "workId", "generation", "holder"] as const;
export function validWorkProcessScope(scope: WorkProcessScope): boolean {
  return scope !== null && typeof scope === "object" && Number.isSafeInteger(scope.generation) && scope.generation > 0
    && workProcessScopeKeys.filter(k => k !== "generation").every(k => typeof scope[k] === "string" && scope[k].trim().length > 0 && scope[k].length <= 512 && !/[\u0000-\u001f\u007f]/.test(scope[k]));
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]) { return Object.keys(value).length === expected.length && Object.keys(value).every(k => expected.includes(k)); }
export function parseWorkProcessObservation(value: unknown, runtimeId: string, scope: WorkProcessScope): WorkProcessObservation {
  if (!object(value) || !keys(value, ["status", "runtimeId", "process", "work"]) || value.status !== "running" || value.runtimeId !== runtimeId
    || !object(value.process) || !keys(value.process, ["id", "epoch", "pid", "startTicks"])
    || typeof value.process.id !== "string" || !value.process.id || typeof value.process.epoch !== "string" || !value.process.epoch
    || !Number.isSafeInteger(value.process.pid) || (value.process.pid as number) < 1 || typeof value.process.startTicks !== "string" || !/^\d+$/.test(value.process.startTicks)
    || !object(value.work) || !keys(value.work, [...workProcessScopeKeys, "attemptId"])
    || workProcessScopeKeys.some(k => (value.work as Record<string, unknown>)[k] !== scope[k])
    || value.work.attemptId !== `environment-work-claim:${scope.generation}`) throw new Error("Work process observation unavailable or mismatched");
  return { status: "running", runtimeId, process: { id: value.process.id, epoch: value.process.epoch, pid: value.process.pid as number, startTicks: value.process.startTicks }, work: { workspaceId: scope.workspaceId, environmentId: scope.environmentId, sessionId: scope.sessionId, workId: scope.workId, generation: scope.generation, holder: scope.holder, attemptId: `environment-work-claim:${scope.generation}` } };
}
