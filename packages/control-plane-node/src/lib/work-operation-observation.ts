/** Deliberately excludes errors, request bodies, argv and environment values. */
export interface WorkOperationObservation {
  operation: string;
  status: "started" | "completed" | "failed";
  durationMs: number;
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  generation?: number;
  attemptId?: string;
  runtimeId?: string;
  processId?: string;
  requestingWorkId?: string;
  requestingGeneration?: number;
  management?: import("./work-management-rpc.js").ManagementRpcObservation;
}
export async function observeWorkOperation<T>(
  emit: ((event: WorkOperationObservation) => void) | undefined,
  scope: Omit<WorkOperationObservation, "operation" | "status" | "durationMs">,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const report = (status: WorkOperationObservation["status"]) => {
    try { emit?.({ ...scope, operation, status, durationMs: Date.now() - start }); }
    catch { /* Observability must not change ownership or execution. */ }
  };
  report("started");
  try { const result = await run(); report("completed"); return result; }
  catch (error) { report("failed"); throw error; }
}
