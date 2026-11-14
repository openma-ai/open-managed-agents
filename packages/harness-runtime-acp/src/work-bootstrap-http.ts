import type {WorkTerminalReceipt} from "./work-finalization-http.js";
export interface WorkBootstrapClaim {workspaceId:string;environmentId:string;sessionId:string;workId:string;generation:number;holder:string}
export interface WorkBootstrapRoot {inputId:string;turnId:string;position:{revision:number;index:number}}
export type WorkBootstrapPlan =
 | {type:"run";claim:WorkBootstrapClaim;revision:number;root:WorkBootstrapRoot}
 | {type:"cleanup-only"|"parked";claim:WorkBootstrapClaim;revision:number;root:WorkBootstrapRoot;terminal:WorkTerminalReceipt}
 | {type:"idle";claim:WorkBootstrapClaim;revision:number;root:null}
 | {type:"gap"|"rejected";reason:string;revision?:number;root?:WorkBootstrapRoot};
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==="string"&&v.trim().length>0;
const revision=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
function root(v:unknown):v is WorkBootstrapRoot {return record(v)&&text(v.inputId)&&text(v.turnId)&&record(v.position)&&revision(v.position.revision)&&Number.isSafeInteger(v.position.index)&&Number(v.position.index)>=0;}
function terminal(v:unknown,turnId:string,max:number):v is WorkTerminalReceipt {
 if(!record(v)||!text(v.eventId)||v.turnId!==turnId||!text(v.workId)||!revision(v.generation)||!revision(v.revision)||v.revision>max||!record(v.stopReason))return false;
 const reason=v.stopReason;
 return reason.type==="requires_action"?Array.isArray(reason.eventIds)&&reason.eventIds.length>0&&reason.eventIds.every(text):["end_turn","budget_reached","retries_exhausted","interrupted"].includes(String(reason.type));
}
export function createWorkBootstrapHttpClient(options:{apiBaseUrl:string;sessionId:string;environmentId:string;workId:string;sessionsToken:string;fetch?:typeof globalThis.fetch}) {
 const base=new URL(options.apiBaseUrl);
 if(!["http:","https:"].includes(base.protocol)||base.username||base.password||![options.sessionId,options.environmentId,options.workId,options.sessionsToken].every(text))throw new TypeError("Invalid Work bootstrap connection");
 return {async read(signal:AbortSignal):Promise<WorkBootstrapPlan>{
  signal.throwIfAborted();
  const response=await (options.fetch??globalThis.fetch)(new URL(`/v1/oma/sessions/${encodeURIComponent(options.sessionId)}/work-bootstrap`,base),{method:"POST",redirect:"error",signal,headers:{authorization:`Bearer ${options.sessionsToken}`,"content-type":"application/json"},body:"{}"});
  const value:unknown=await response.json();
  const invalid=()=>new Error(`Invalid Work bootstrap response (${response.status})`);
  if(!record(value))throw invalid();
  if(value.type==="gap"||value.type==="rejected") {
   if(response.status!==409||!text(value.reason)||(value.revision!==undefined&&!revision(value.revision))||(value.root!==undefined&&!root(value.root)))throw invalid();
  }else{
   const claim=value.claim;
   if(response.status!==200||!revision(value.revision)||!record(claim)||!text(claim.workspaceId)||claim.environmentId!==options.environmentId||claim.sessionId!==options.sessionId||claim.workId!==options.workId||!revision(claim.generation)||!text(claim.holder))throw invalid();
   if(value.type==="idle"){if(value.root!==null)throw invalid();}
   else {
    if(!root(value.root)||value.root.position.revision>value.revision)throw invalid();
    if(value.type==="cleanup-only"||value.type==="parked") {
     if(!terminal(value.terminal,value.root.turnId,value.revision))throw invalid();
     const parked=["requires_action","budget_reached"].includes(value.terminal.stopReason.type);
     if((value.type==="parked")!==parked)throw invalid();
    }else if(value.type!=="run")throw invalid();
   }
  }
  signal.throwIfAborted();
  return value as unknown as WorkBootstrapPlan;
 }};
}
