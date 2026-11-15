/** Private Work input protocol, not the public Session event pagination API. */
export interface WorkInputClaim {
  workspaceId: string; sessionId: string; environmentId: string;
  workId: string; generation: number; holder: string;
}
export interface WorkInputPosition { revision: number; index: number }
export interface WorkInputRow {
  event: object;
  position: WorkInputPosition;
  /** Exact canonical input bytes for CAS, private protocol only. */
  document: string;
}
export type WorkInputBoundary = "before_dispatch" | "after_acceptance" | "acceptance_unknown";
export interface ConsumeWorkInput {
  claim: WorkInputClaim;
  inputId: string;
  /** Stable turn identity, never Work generation or worker attempt identity. */
  turnId: string;
  expectedDocument: string;
  /** Actual consumer; defaults to the admission/dispatch turnId. */
  consumingTurnId?: string;
  /** Exact already-consumed root evidence, required for a different consumer. */
  rootInputId?: string;
  expectedRootDocument?: string;
  boundary: WorkInputBoundary;
}
export type WorkInputGap = { type: "gap"; reason: string };
export type WorkInputConsumption = WorkInputGap | { type: "rejected" } |
  { type: "consumed"; inputId: string; turnId: string; consumingTurnId?: string; boundary: "before_dispatch" };
export interface WorkInputsPort {
  /** Must use an indexed source-position seek, exclusive after, at most limit
   * rows plus one lookahead. All canonical sources must be covered or return a
   * gap; legacy/unpositioned rows may not silently disappear. */
  read(input: { claim: WorkInputClaim; after: WorkInputPosition | null; limit: number }): Promise<
    WorkInputGap | { type: "rejected" } | { type: "page"; rows: WorkInputRow[]; hasMore: boolean }>;
  /** Fence + raw input CAS MUST be in one transaction. A check-then-mark adapter
   * does not satisfy this port. No accepted/unknown success without a durable
   * receipt that identifies input, turn and acceptance boundary. */
  consume(input: ConsumeWorkInput): Promise<WorkInputConsumption>;
}
const validPosition=(p:WorkInputPosition)=>Number.isSafeInteger(p.revision)&&p.revision>0&&Number.isSafeInteger(p.index)&&p.index>=0;
const after=(a:WorkInputPosition,b:WorkInputPosition)=>a.revision>b.revision||(a.revision===b.revision&&a.index>b.index);
function encode(claim:WorkInputClaim,position:WorkInputPosition) {
  // URI encoding keeps the base64 codec portable between Node and Workers.
  return btoa(encodeURIComponent(JSON.stringify([1,claim.workspaceId,claim.sessionId,position.revision,position.index]))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
}
function decode(cursor:string,claim:WorkInputClaim):WorkInputPosition {
  if(!cursor||cursor.length>8192||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error("cursor");
  const value:unknown=JSON.parse(decodeURIComponent(atob(cursor.replace(/-/g,"+").replace(/_/g,"/"))));
  if(!Array.isArray(value)||value.length!==5||value[0]!==1||value[1]!==claim.workspaceId||value[2]!==claim.sessionId)throw Error("cursor");
  const position={revision:value[3],index:value[4]};
  if(!validPosition(position))throw Error("cursor");
  return position;
}
export class WorkInputsApplication {
  constructor(private readonly store:WorkInputsPort) {}
  async read(input:{claim:WorkInputClaim;cursor:string|null;limit:number}) {
    if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>200)return {type:"invalid" as const,reason:"limit"};
    let position:WorkInputPosition|null;
    try {position=input.cursor===null?null:decode(input.cursor,input.claim);}catch{return {type:"invalid" as const,reason:"cursor"};}
    const result=await this.store.read({claim:input.claim,after:position,limit:input.limit});
    if(result.type!=="page")return result;
    let previous=position;
    for(const row of result.rows) {
      if(!validPosition(row.position)||(previous!==null&&!after(row.position,previous)))return {type:"gap" as const,reason:"invalid_ordered_page"};
      previous=row.position;
    }
    if(result.rows.length>input.limit||(result.hasMore&&result.rows.length===0))return {type:"gap" as const,reason:"invalid_ordered_page"};
    return {...result,cursor:previous===null?input.cursor:encode(input.claim,previous)};
  }
  consume(input:ConsumeWorkInput) { return this.store.consume(input); }
}
