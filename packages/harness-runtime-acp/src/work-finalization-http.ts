import { logWarn } from "@open-managed-agents/shared/log";

/** Private Work protocol. Transport uncertainty is not proof of non-commit. */
export type WorkStopReason = {type:"end_turn"|"budget_reached"|"retries_exhausted"|"interrupted"}
  | {type:"requires_action";eventIds:string[]};
export interface WorkTerminalReceipt {
  eventId:string;turnId:string;workId:string;generation:number;revision:number;stopReason:WorkStopReason;
}
export type WorkFinalizationResult =
  | {type:"run"|"prepared";turnId:string;revision:number}
  | {type:"committed"|"parked"|"published";revision:number;terminal:WorkTerminalReceipt}
  | {type:"gap"|"rejected";reason:string;revision?:number}
  | {type:"unavailable";phase:"finalization"}
  | {type:"failed";phase:"run"|"finalization";terminal?:WorkTerminalReceipt};
export class WorkFinalizationTransportError extends Error {
  readonly outcome = "unknown";
  readonly diagnostics?: WorkFinalizationTransportDiagnostics;
  constructor(cause:unknown, diagnostics?:WorkFinalizationTransportDiagnostics) {
    super("Work finalization response unavailable", {cause});
    this.name = "WorkFinalizationTransportError";
    this.diagnostics = diagnostics;
  }
}
export interface WorkFinalizationTransportDiagnostics {
  action: string;
  status?: number;
  contentType?: string;
  bodyKind: "json" | "html" | "empty" | "other";
  bodyBytes?: number;
}
const record = (v:unknown):v is Record<string,unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v:unknown):v is string => typeof v === "string" && v.length > 0;
const revision = (v:unknown):v is number => Number.isSafeInteger(v) && Number(v) > 0;
function stopReason(v:unknown):v is WorkStopReason {
  if (!record(v)) return false;
  return v.type === "requires_action" ? Array.isArray(v.eventIds) && v.eventIds.length > 0 && v.eventIds.every(text)
    : ["end_turn","budget_reached","retries_exhausted","interrupted"].includes(String(v.type));
}
function receipt(v:unknown,turnId:string):v is WorkTerminalReceipt {
  return record(v) && v.turnId === turnId && text(v.eventId) && text(v.workId) && revision(v.generation) && revision(v.revision) && stopReason(v.stopReason);
}
function decode(value:unknown,turnId:string,status:number,action:string):WorkFinalizationResult {
  const invalid = () => new Error("Invalid Work finalization response");
  if (!record(value)) throw invalid();
  if (value.type === "rejected" || value.type === "gap") {
    if (status !== 409 || !text(value.reason) || (value.revision !== undefined && !revision(value.revision))) throw invalid();
  } else if (value.type === "unavailable") {
    if (status !== 503 || value.phase !== "finalization") throw invalid();
  } else if (value.type === "failed") {
    if (status !== 502 || !["run","finalization"].includes(String(value.phase)) || (value.terminal !== undefined && !receipt(value.terminal,turnId))) throw invalid();
  } else if (value.type === "run" || value.type === "prepared") {
    if (status !== 200 || value.turnId !== turnId || !revision(value.revision) ||
        (value.type === "run" ? action !== "work-recovery" : action !== "work-checkpoint")) throw invalid();
  } else if (["committed","parked","published"].includes(String(value.type))) {
    if (status !== 200 || !revision(value.revision) || !receipt(value.terminal,turnId) || value.revision < value.terminal.revision) throw invalid();
    const parked = ["requires_action","budget_reached"].includes(value.terminal.stopReason.type);
    if (value.type !== "published" && (value.type === "parked") !== parked) throw invalid();
    if (value.type === "published" && action !== "work-publish") throw invalid();
  } else throw invalid();
  return value as unknown as WorkFinalizationResult;
}
export function createWorkFinalizationHttpClient(options:{apiBaseUrl:string;sessionId:string;sessionsToken:string;fetch?:typeof globalThis.fetch}) {
  const base = new URL(options.apiBaseUrl);
  if (!["https:","http:"].includes(base.protocol) || base.username || base.password || !text(options.sessionId) || !text(options.sessionsToken)) throw new TypeError("Invalid Work finalization connection");
  async function post(action:string,body:{turnId:string;revision?:number},signal:AbortSignal):Promise<WorkFinalizationResult> {
    if (!text(body.turnId) || (body.revision !== undefined && !revision(body.revision))) throw new TypeError("Invalid canonical Work turn");
    signal.throwIfAborted();
    let response:Response;
    let value:unknown;
    let diagnostics: WorkFinalizationTransportDiagnostics = { action, bodyKind: "empty" };
    try {
      response = await (options.fetch ?? globalThis.fetch)(new URL(`/v1/oma/sessions/${encodeURIComponent(options.sessionId)}/${action}`,base),{
        method:"POST",redirect:"error",signal,headers:{authorization:`Bearer ${options.sessionsToken}`,"content-type":"application/json"},body:JSON.stringify(body),
      });
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const trimmed = raw.trimStart();
      diagnostics = {
        action,
        status: response.status,
        contentType,
        bodyKind: trimmed.length === 0 ? "empty" : contentType.toLowerCase().includes("html") || /^<(?:!doctype\s+)?html[\s>]/i.test(trimmed) ? "html" : /^[{[]/.test(trimmed) ? "json" : "other",
        bodyBytes: Buffer.byteLength(raw),
      };
      try { value = raw.length === 0 ? null : JSON.parse(raw); }
      catch (error) {
        logWarn({op:"work.finalization.transport",session_id:options.sessionId,...diagnostics,err:error},"Work finalization response was not JSON");
        throw new WorkFinalizationTransportError(error, diagnostics);
      }
    } catch (error) {
      if (error instanceof WorkFinalizationTransportError) throw error;
      logWarn({op:"work.finalization.transport",session_id:options.sessionId,...diagnostics,err:error},"Work finalization response unavailable");
      throw new WorkFinalizationTransportError(error, diagnostics);
    }
    // Read the ACK even if cancellation raced it; callers still recheck lease
    // before further I/O. Never erase a committed receipt with an abort error.
    return decode(value,body.turnId,response.status,action);
  }
  return {
    recover:(turnId:string,signal:AbortSignal) => post("work-recovery",{turnId},signal),
    checkpoint:(input:{turnId:string;revision:number},signal:AbortSignal) => post("work-checkpoint",input,signal),
    finalize:(input:{turnId:string;revision:number;stopReason:WorkStopReason},signal:AbortSignal) => post("work-finalize",input,signal),
    publish:(input:{turnId:string;revision:number;terminalEventId:string},signal:AbortSignal) => post("work-publish",input,signal),
    fail:(input:{turnId:string;revision:number;phase:"run"|"finalization"},signal:AbortSignal) => post("work-failed",input,signal),
  };
}
