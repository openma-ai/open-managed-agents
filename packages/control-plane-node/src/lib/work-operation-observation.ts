/** Deliberately excludes error messages, request bodies, argv and environment values. */
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
  error_name?: string;
}
function safeError(error: unknown): { error_name?: string } {
  if (error instanceof Error) {
    // Error messages may contain credentials, request bodies, or provider
    // response text. Keep only the stable class/name for telemetry.
    return { error_name: error.name.slice(0, 120) };
  }
  if (typeof error === "string") return { error_name: "Error" };
  return { error_name: "UnknownError" };
}
export async function observeWorkOperation<T>(
  emit: ((event: WorkOperationObservation) => void) | undefined,
  scope: Omit<WorkOperationObservation, "operation" | "status" | "durationMs">,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const report = (status: WorkOperationObservation["status"], error?: unknown) => {
    try {
      emit?.({ ...scope, operation, status, durationMs: Date.now() - start,
        ...(status === "failed" ? safeError(error) : {}) });
    }
    catch { /* Observability must not change ownership or execution. */ }
  };
  report("started");
  try { const result = await run(); report("completed"); return result; }
  catch (error) { report("failed", error); throw error; }
}
