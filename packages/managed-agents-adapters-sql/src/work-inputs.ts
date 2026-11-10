import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import type {
  ConsumeWorkInput,
  WorkInputClaim as Claim,
  WorkInputConsumption,
  WorkInputPosition as Position,
  WorkInputRow,
  WorkInputsPort,
} from "@open-managed-agents/managed-agents-application";

export type SqlWorkInputsDialect = "sqlite" | "postgres" | "mysql";

const indexName = "managed_session_events_source_position";
const bootstrapInvalidIndexName = "managed_session_initial_events_source_position_invalid";
const invalidIndexName = "managed_session_events_source_position_invalid";
const maxSafeInteger = "9007199254740991";

/** Source-position SQL shared verbatim with the migrations. The reader only
 * runs when the catalog proves these exact indexes exist. */
export const sqliteSourcePositionSql = (() => {
  const revision = "json_extract(document, '$.source_position.revision')";
  const ordinal = "json_extract(document, '$.source_position.index')";
  const invalid = "(json_type(document, '$.source_position.revision') IS NOT 'integer' OR json_type(document, '$.source_position.index') IS NOT 'integer' OR " +
    revision + " NOT BETWEEN 1 AND " + maxSafeInteger + " OR " + ordinal + " NOT BETWEEN 0 AND " + maxSafeInteger + ")";
  return {
    revision, ordinal, invalid,
    index: "CREATE UNIQUE INDEX " + indexName + " ON managed_session_events(workspace_id,session_id," + revision + "," + ordinal + ")",
    invalidIndex: "CREATE INDEX " + invalidIndexName + " ON managed_session_events(workspace_id,session_id) WHERE " + invalid,
  };
})();

/** PostgreSQL stores documents as text. The CASE keeps index maintenance from
 * throwing on a non-integer position; such rows land in the invalid index. */
export const postgresSourcePositionSql = (() => {
  const json = "(document::jsonb)";
  const field = (name: string) => "(CASE WHEN jsonb_typeof(" + json + " #> '{source_position," + name + "}') = 'number' AND (" +
    json + " #>> '{source_position," + name + "}') ~ '^[0-9]{1,16}$' THEN (" + json + " #>> '{source_position," + name + "}')::bigint END)";
  const revision = field("revision");
  const ordinal = field("index");
  const invalid = "(" + revision + " IS NULL OR " + ordinal + " IS NULL OR " + revision + " < 1 OR " + revision + " > " + maxSafeInteger +
    " OR " + ordinal + " > " + maxSafeInteger + ")";
  return {
    revision, ordinal, invalid,
    index: "CREATE UNIQUE INDEX \"" + indexName + "\" ON \"managed_session_events\" USING btree (\"workspace_id\",\"session_id\"," + revision + "," + ordinal + ")",
    invalidIndex: "CREATE INDEX \"" + invalidIndexName + "\" ON \"managed_session_events\" USING btree (\"workspace_id\",\"session_id\") WHERE " + invalid,
  };
})();

const bootstrapInvalid = (dialect: SqlWorkInputsDialect) => {
  if (dialect === "mysql") return "work_input_invalid=1";
  if (dialect === "postgres") return "((document::jsonb #> '{source_position,revision}') IS DISTINCT FROM '1'::jsonb OR (document::jsonb #> '{source_position,index}') IS DISTINCT FROM sequence::text::jsonb OR (document::jsonb ->> 'id') IS DISTINCT FROM ('bootstrap_' || session_id || ':' || sequence::text))";
  return "(json_extract(document, '$.source_position.revision') IS NOT 1 OR json_type(document, '$.source_position.revision') IS NOT 'integer' OR json_extract(document, '$.source_position.index') IS NOT sequence OR json_type(document, '$.source_position.index') IS NOT 'integer' OR json_extract(document, '$.id') IS NOT ('bootstrap_' || session_id || ':' || sequence))";
};

const gap = (reason: string) => ({ type: "gap" as const, reason });
const rejected = { type: "rejected" as const };
const validClaim = (c: Claim) => [c.workspaceId,c.sessionId,c.environmentId,c.workId,c.holder].every(v => typeof v === "string" && v.length > 0) && Number.isSafeInteger(c.generation) && c.generation > 0;
const validPosition = (p: Position) => Number.isSafeInteger(p.revision) && p.revision > 0 && Number.isSafeInteger(p.index) && p.index >= 0;
const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const comparePositions = (a: Position, b: Position) => a.revision - b.revision || a.index - b.index;
const dispatchableTypes = ["user.message","system.message","user.tool_confirmation","user.custom_tool_result","user.define_outcome","user.tool_result"];
// These canonical writers stamp acceptance, not dispatch. As in the fixed
// Node consume boundary, the source consumption marker remains authoritative.
const acceptanceStampedInput = (event: {type:string}, raw: Record<string, unknown>) =>
  event.type === "user.define_outcome" || event.type === "user.tool_result" ||
  (event.type === "session.updated" && raw.resume === true);

/** Bootstrap rows live in managed_session_initial_events. Their canonical
 * position is written by the Session insert: revision 1, index = sequence. */
function bootstrapSequence(sessionId: string, inputId: string): number | null {
  const prefix = "bootstrap_" + sessionId + ":";
  if (!inputId.startsWith(prefix)) return null;
  const digits = inputId.slice(prefix.length);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(digits)) return null;
  const sequence = Number(digits);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

/** SQL implementation of the private Work input port.
 * sourcePositionsValidated is a deployment/migration prerequisite, NOT a caller
 * request flag: the composition root sets it only where the validating
 * source-position migration is part of the deployed migration chain. The
 * reader additionally proves the migration's indexes exist on every call. */
export class SqlWorkInputs implements WorkInputsPort {
  constructor(private readonly sql: SqlClient, private readonly options: {
    /** @deprecated Retained for source compatibility; authority and stamps use the database clock. */
    now?: () => number;
    sourcePositionsValidated?: boolean;
    dialect?: SqlWorkInputsDialect;
  } = {}) {}

  private get dialect(): SqlWorkInputsDialect { return this.options.dialect ?? "sqlite"; }
  private get positions() {
    if (this.dialect === "mysql") return {revision:"work_input_revision",ordinal:"work_input_index",invalid:"work_input_invalid=1"};
    return this.dialect === "postgres" ? postgresSourcePositionSql : sqliteSourcePositionSql;
  }
  private indexed(name: string) { return this.dialect === "sqlite" ? " INDEXED BY " + name : this.dialect === "mysql" ? " FORCE INDEX (" + name + ")" : ""; }

  /** Work fence as an EXISTS term for statements on other tables. */
  private get clockMs(): string {
    if (this.dialect === "postgres") return "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
    // MySQL CURRENT_TIMESTAMP is statement-scoped, not transaction-scoped.
    // The final CAS is a separate statement AFTER both authority locks and
    // the event mutation: no pre-lock statement timestamp can authorize commit.
    if (this.dialect === "mysql") return "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)";
    // strftime('now') is stable within sqlite3_step, not across the batch.
    return "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  }

  private get clockIso(): string {
    if (this.dialect === "postgres") return "to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
    if (this.dialect === "mysql") return "CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%f'),23),'Z')";
    return "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  }

  private fence(claim: Claim) {
    return {
      sql: "EXISTS (SELECT 1 FROM managed_environment_work WHERE workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ? AND state IN ('starting','active') AND claim_generation = ? AND claim_worker_id = ? AND claim_at IS NOT NULL AND claim_at + heartbeat_ttl_seconds * 1000 > " + this.clockMs + ")",
      bindings: [claim.workspaceId,claim.environmentId,claim.workId,claim.sessionId,claim.generation,claim.holder],
    };
  }

  private async indexesPresent(): Promise<boolean> {
    if (this.dialect !== "mysql") {
      const bootstrap = this.dialect === "sqlite"
        ? await this.sql.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='managed_session_initial_events' AND name=?").bind(bootstrapInvalidIndexName).first<{sql:string}>()
        : await this.sql.prepare("SELECT indexdef AS sql FROM pg_indexes WHERE schemaname=current_schema() AND tablename='managed_session_initial_events' AND indexname=?").bind(bootstrapInvalidIndexName).first<{sql:string}>();
      if (!bootstrap || (this.dialect === "sqlite"
        ? normalize(bootstrap.sql) !== normalize("CREATE INDEX " + bootstrapInvalidIndexName + " ON managed_session_initial_events(workspace_id,session_id) WHERE " + bootstrapInvalid("sqlite"))
        : !bootstrap.sql.includes(" WHERE "))) return false;
    }
    if (this.dialect === "mysql") {
      const indexes=await this.sql.prepare("SELECT index_name AS name, MIN(non_unique) AS non_unique, GROUP_CONCAT(COALESCE(column_name, '<expression>') ORDER BY seq_in_index) AS columns FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name IN ('managed_session_events','managed_session_initial_events') AND index_name IN (?,?,?) GROUP BY table_name,index_name")
        .bind(indexName,invalidIndexName,bootstrapInvalidIndexName).all<{name:string;non_unique:number;columns:string}>();
      return [[indexName,"workspace_id,session_id,work_input_revision,work_input_index",0],
        [invalidIndexName,"workspace_id,session_id,work_input_invalid",1],
        [bootstrapInvalidIndexName,"workspace_id,session_id,work_input_invalid",1]].every(([name,columns,unique]) =>
          indexes.results?.some(row=>row.name===name && row.columns===columns && Number(row.non_unique)===unique));
    }
    if (this.dialect === "sqlite") {
      const rows = await this.sql.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'managed_session_events' AND name IN (?, ?)")
        .bind(indexName, invalidIndexName).all<{ name: string; sql: string | null }>();
      const byName = new Map((rows.results ?? []).map(row => [row.name, normalize(row.sql ?? "")]));
      return byName.get(indexName) === normalize(sqliteSourcePositionSql.index) && byName.get(invalidIndexName) === normalize(sqliteSourcePositionSql.invalidIndex);
    }
    // pg_indexes returns a deparsed definition; check the shape, not the text.
    const rows = await this.sql.prepare("SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'managed_session_events' AND indexname IN (?, ?)")
      .bind(indexName, invalidIndexName).all<{ name: string; sql: string }>();
    const byName = new Map((rows.results ?? []).map(row => [row.name, row.sql]));
    const unique = byName.get(indexName) ?? "";
    const invalid = byName.get(invalidIndexName) ?? "";
    return /^CREATE UNIQUE INDEX /.test(unique) && /source_position,revision/.test(unique) && /source_position,index/.test(unique)
      && / WHERE /.test(invalid) && /source_position,revision/.test(invalid);
  }

  async read(input: { claim: Claim; after: Position | null; limit: number }) {
    const {claim,after,limit}=input;
    if (!validClaim(claim) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (after !== null && !validPosition(after))) return rejected;
    // Constant-size schema lookup; never fall back to a history scan/sort.
    if (!await this.indexesPresent()) return gap("source_position_index_required");
    if (!this.options.sourcePositionsValidated) return gap("source_position_validation_required");
    const fence=this.fence(claim);
    const {revision,ordinal,invalid}=this.positions;
    const readsBootstrap = after === null || after.revision === 1;
    const statements: SqlStatement[] = [
      this.sql.prepare("SELECT revision FROM managed_sessions WHERE workspace_id=? AND id=? AND environment_id=? AND archived_at IS NULL AND " + fence.sql).bind(claim.workspaceId,claim.sessionId,claim.environmentId,...fence.bindings),
      this.sql.prepare("SELECT document FROM managed_session_events" + this.indexed(indexName) + " WHERE workspace_id=? AND session_id=? AND " + revision + "=? AND " + ordinal + ">? ORDER BY " + ordinal + " LIMIT ?")
        .bind(claim.workspaceId,claim.sessionId,after?.revision ?? 0,after?.index ?? 0,limit+1),
      this.sql.prepare("SELECT document FROM managed_session_events" + this.indexed(indexName) + " WHERE workspace_id=? AND session_id=? AND " + revision + ">? ORDER BY " + revision + "," + ordinal + " LIMIT ?")
        .bind(claim.workspaceId,claim.sessionId,after?.revision ?? 0,limit+1),
      // Bootstrap rows precede revision 2+; seek the (session_id, sequence) key.
      ...(readsBootstrap ? [this.sql.prepare("SELECT sequence, document FROM managed_session_initial_events WHERE workspace_id=? AND session_id=? AND sequence>? ORDER BY sequence LIMIT ?")
        .bind(claim.workspaceId,claim.sessionId,after === null ? -1 : after.index,limit+1)] : []),
      // Validate legacy bootstrap even after the cursor passed revision 1.
      // The partial index makes this independent of history length.
      this.sql.prepare("SELECT 1 AS present FROM managed_session_initial_events" + this.indexed(bootstrapInvalidIndexName) + " WHERE workspace_id=? AND session_id=? AND " + bootstrapInvalid(this.dialect) + " LIMIT 1")
        .bind(claim.workspaceId,claim.sessionId),
      // Last invalid probe: under READ COMMITTED it observes at least what the seeks saw.
      this.sql.prepare("SELECT 1 AS present FROM managed_session_events" + this.indexed(invalidIndexName) + " WHERE workspace_id=? AND session_id=? AND " + invalid + " LIMIT 1")
        .bind(claim.workspaceId,claim.sessionId),
      this.sql.prepare("SELECT revision FROM managed_sessions WHERE workspace_id=? AND id=? AND environment_id=? AND archived_at IS NULL AND " + fence.sql).bind(claim.workspaceId,claim.sessionId,claim.environmentId,...fence.bindings),
    ];
    const results=await this.sql.batch<{document:string;sequence?:number;revision?:number}>(statements);
    if (results[0]?.results?.length !== 1 || results.at(-1)?.results?.length !== 1) return rejected;
    if (results.at(-3)?.results?.length) return gap("bootstrap_ordered_reader_required");
    if (results.at(-2)?.results?.length) return gap("source_position_validation_required");
    const rows: WorkInputRow[] = [];
    for (const row of [...(results[1]?.results ?? []),...(results[2]?.results ?? [])]) {
      const decoded=decodeSessionEventDocument(row.document);
      if (!decoded.position) return gap("source_position_validation_required");
      rows.push({event:decoded.event,position:decoded.position,document:row.document});
    }
    if (readsBootstrap) for (const row of results[3]?.results ?? []) {
      const sequence=Number(row.sequence);
      const decoded=decodeSessionEventDocument(row.document);
      // Legacy plain bootstrap rows carry no consumption state; never guess.
      if (!decoded.position || decoded.position.revision !== 1 || decoded.position.index !== sequence || decoded.event.id !== "bootstrap_" + claim.sessionId + ":" + sequence)
        return gap("bootstrap_ordered_reader_required");
      rows.push({event:decoded.event,position:decoded.position,document:row.document});
    }
    // Bounded ordered merge: each source contributes at most limit+1 rows.
    rows.sort((a,b)=>comparePositions(a.position,b.position));
    for (let i=1;i<rows.length;i++) if (comparePositions(rows[i-1]!.position,rows[i]!.position)===0) return gap("source_position_conflict");
    const page=rows.slice(0,limit+1);
    return {type:"page" as const,rows:page.slice(0,limit),hasMore:page.length>limit};
  }

  /** Read a bounded proof snapshot. The transaction's Session revision CAS
   * freezes all canonical writers; exact root bytes are also checked in SQL. */
  private async ownershipProof(input: ConsumeWorkInput, child: ReturnType<typeof decodeSessionEventDocument>, revision: number) {
    const rootId=input.rootInputId!, expected=input.expectedRootDocument!, consumer=input.consumingTurnId!;
    let root: ReturnType<typeof decodeSessionEventDocument>, raw: Record<string, any>;
    try { root=decodeSessionEventDocument(expected);raw=JSON.parse(expected); } catch { return null; }
    const c=input.claim, proof=raw.source_position?.consumption_claim;
    if(!root.position || !child.position || root.event.id!==rootId || (root.executionId??rootId)!==consumer ||
      root.consumedByExecutionId!==consumer || comparePositions(root.position,child.position)>=0 || child.position.revision>revision ||
      !proof || proof.workId!==c.workId || proof.generation!==c.generation || proof.holder!==c.holder ||
      typeof raw.processedAt!=="string" || !Number.isFinite(Date.parse(raw.processedAt)) || raw._queued===true || raw.cancelled_at_ms!=null ||
      raw.deferredUntilToolResults!==undefined || raw.deferred_until_tool_results!==undefined ||
      !(dispatchableTypes.includes(root.event.type)&&root.event.type!=="system.message" || root.event.type==="session.updated"&&raw.resume===true) ||
      (raw.sessionThreadId??"sthr_primary")!==((child.event as {sessionThreadId?:string}).sessionThreadId??"sthr_primary")) return null;
    const sequence=bootstrapSequence(c.sessionId,rootId);
    if(sequence!==null&&(root.position.revision!==1||root.position.index!==sequence))return null;
    const rawCas=this.dialect==="mysql"?"BINARY document=BINARY ?":"document=?";
    const rootWhere="workspace_id=? AND session_id=? AND "+(sequence===null?"id=?":"sequence=?")+" AND "+rawCas;
    const table=sequence===null?"managed_session_events":"managed_session_initial_events";
    const bindings=[c.workspaceId,c.sessionId,sequence??rootId,expected];
    if(!await this.sql.prepare("SELECT 1 FROM "+table+" WHERE "+rootWhere).bind(...bindings).first())return null;
    if(await this.sql.prepare("SELECT 1 FROM managed_session_events"+this.indexed(invalidIndexName)+" WHERE workspace_id=? AND session_id=? AND "+this.positions.invalid+" LIMIT 1").bind(c.workspaceId,c.sessionId).first())return null;
    const {revision:rev,ordinal}=this.positions;
    const rows=await this.sql.prepare("SELECT document FROM managed_session_events"+this.indexed(indexName)+" WHERE workspace_id=? AND session_id=? AND "+rev+">=? ORDER BY "+rev+","+ordinal+" LIMIT 201")
      .bind(c.workspaceId,c.sessionId,root.position.revision).all<{document:string}>();
    // No unbounded history scan, and never treat truncated evidence as proof.
    if((rows.results?.length??0)>200)return null;
    const facts: Array<{raw:Record<string,any>;decoded:ReturnType<typeof decodeSessionEventDocument>}>=[];
    for(const row of rows.results??[]){
      let decoded:ReturnType<typeof decodeSessionEventDocument>,event:Record<string,any>;
      try{decoded=decodeSessionEventDocument(row.document);event=JSON.parse(row.document);}catch{return null;}
      if(!decoded.position||decoded.position.revision>revision)return null;
      if(comparePositions(decoded.position,root.position)<=0)continue;
      facts.push({raw:event,decoded});
      // Once a distinct root has actually consumed a successor, the earlier
      // prompt is not an active absorption owner. Queued/unconsumed successors
      // remain untouched and do not establish a new consuming turn.
      if(decoded.consumedByExecutionId && decoded.consumedByExecutionId!==consumer &&
        (dispatchableTypes.includes(decoded.event.type)||decoded.event.type==="session.updated"&&event.resume===true))return null;
      if(event.type==="session.status_terminated" || event.type==="session.status_idle"){
        // Unattributed control facts cannot establish an open root. A parked
        // approval is the only idle that is not a completion for absorption.
        if(decoded.executionId===undefined)return null;
        if(decoded.executionId===consumer && (event.type!=="session.status_idle"||event.stopReason?.type!=="requires_action" ||
          decoded.environmentWork?.workId!==c.workId||decoded.environmentWork?.generation!==c.generation))return null;
      }
    }
    const event=child.event as typeof child.event & {toolUseId?:string;customToolUseId?:string};
    if(["user.tool_confirmation","user.tool_result","user.custom_tool_result"].includes(event.type)){
      const id=event.type==="user.custom_tool_result"?event.customToolUseId:event.toolUseId;
      const type=event.type==="user.custom_tool_result"?"agent.custom_tool_use":"agent.tool_use";
      const tool=facts.find(f=>f.raw.id===id&&f.raw.type===type);
      if(!id||!tool||(event.type==="user.tool_confirmation"&&tool.raw.evaluatedPermission!=="ask")||tool.decoded.executionId!==consumer||tool.decoded.environmentWork?.workId!==c.workId||
        tool.decoded.environmentWork?.generation!==c.generation||comparePositions(tool.decoded.position!,child.position)>=0||
        (tool.raw.sessionThreadId??"sthr_primary")!==(raw.sessionThreadId??"sthr_primary"))return null;
      if(facts.some(f=>comparePositions(f.decoded.position!,tool.decoded.position!)>0 &&
        ((["agent.tool_result","agent.custom_tool_result"].includes(f.raw.type)&&(f.raw.toolUseId===id||f.raw.customToolUseId===id)) ||
         (["user.tool_confirmation","user.tool_result","user.custom_tool_result"].includes(f.raw.type)&&f.decoded.consumedByExecutionId!==undefined&&
          (f.raw.toolUseId===id||f.raw.customToolUseId===id)))))return null;
    } else if(event.type!=="user.message") return null;
    return {sql:"EXISTS (SELECT 1 FROM "+table+" WHERE "+rootWhere+")",bindings};
  }

  async consume(input: ConsumeWorkInput): Promise<WorkInputConsumption> {
    if (input.boundary === "after_acceptance" || input.boundary === "acceptance_unknown") return gap("acceptance_receipt_not_persisted");
    if (input.boundary !== "before_dispatch" || !validClaim(input.claim)) return rejected;
    if (!this.options.sourcePositionsValidated) return gap("source_position_validation_required");
    if (!await this.indexesPresent()) return gap("source_position_index_required");
    let decoded: ReturnType<typeof decodeSessionEventDocument>;
    let raw: Record<string, any>;
    try { decoded=decodeSessionEventDocument(input.expectedDocument);raw=JSON.parse(input.expectedDocument); } catch { return rejected; }
    const {claim}=input;
    const consumer=input.consumingTurnId??input.turnId;
    if(typeof consumer!=="string"||!consumer||typeof input.inputId!=="string"||!input.inputId||typeof input.turnId!=="string"||!input.turnId)return rejected;
    const cross=consumer!==input.turnId;
    if(cross ? typeof input.rootInputId!=="string"||!input.rootInputId||typeof input.expectedRootDocument!=="string"||!input.expectedRootDocument : input.rootInputId!==undefined||input.expectedRootDocument!==undefined)return rejected;
    const sequence=bootstrapSequence(claim.sessionId,input.inputId);
    if (!decoded.position || decoded.event.id !== input.inputId || input.turnId !== (decoded.executionId ?? input.inputId) ||
      !(dispatchableTypes.includes(decoded.event.type) || (decoded.event.type === "session.updated" && raw.resume === true)) ||
      (decoded.event.processedAt !== null && !(acceptanceStampedInput(decoded.event, raw) &&
        typeof decoded.event.processedAt === "string" && Number.isFinite(Date.parse(decoded.event.processedAt)))) || decoded.consumedByExecutionId || raw.cancelled_at_ms != null || raw._queued === true ||
      raw.deferredUntilToolResults !== undefined || raw.deferred_until_tool_results !== undefined) return rejected;
    if (sequence !== null && (decoded.position.revision !== 1 || decoded.position.index !== sequence)) return rejected;
    const fence=this.fence(claim);
    const session=await this.sql.prepare("SELECT revision FROM managed_sessions WHERE workspace_id=? AND id=?").bind(claim.workspaceId,claim.sessionId).first<{revision:number}>();
    if (!session) return rejected;
    const ownership=cross?await this.ownershipProof(input,decoded,Number(session.revision)):null;
    if(cross&&!ownership)return rejected;
    const current=sequence === null
      ? await this.sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=?").bind(claim.workspaceId,claim.sessionId,input.inputId).first<{document:string}>()
      : await this.sql.prepare("SELECT document FROM managed_session_initial_events WHERE workspace_id=? AND session_id=? AND sequence=?").bind(claim.workspaceId,claim.sessionId,sequence).first<{document:string}>();
    if (!current) return rejected;
    if(current.document !== input.expectedDocument) {
      const consumed=decodeSessionEventDocument(current.document);
      // This is deliberately NOT idempotent success: the legacy marker cannot
      // prove which attempt/boundary produced it or recover a lost receipt.
      return consumed.consumedByExecutionId === consumer ? gap("consumption_receipt_not_persisted") : rejected;
    }
    // Only null/initial stamps are replaced. JSON mutations preserve complete
    // canonical payloads and source metadata, while the WHERE remains raw CAS.
    const stamp=sequence !== null || decoded.event.processedAt === null;
    const baseDocument=JSON.stringify({...raw,source_position:{...raw.source_position,consumed_by_execution_id:consumer,consumption_claim:{workId:claim.workId,generation:claim.generation,holder:claim.holder}}});
    const documentSql=!stamp ? "?" : this.dialect === "postgres"
      ? "jsonb_set(?::text::jsonb,'{processedAt}',to_jsonb(" + this.clockIso + "))::text"
      : "json_set(?, '$.processedAt', " + this.clockIso + ")";
    const sessionWhere="workspace_id=? AND id=? AND environment_id=? AND archived_at IS NULL AND revision=? AND " + fence.sql + (ownership?" AND "+ownership.sql:"");
    const scope=[claim.workspaceId,claim.sessionId,claim.environmentId,Number(session.revision),...fence.bindings,...(ownership?.bindings??[])];
    const workWhere="workspace_id=? AND environment_id=? AND id=? AND session_id=? AND state IN ('starting','active') AND claim_generation=? AND claim_worker_id=? AND claim_at IS NOT NULL AND claim_at + heartbeat_ttl_seconds * 1000 > " + this.clockMs;
    const rawCas=this.dialect === "mysql" ? "BINARY document=BINARY ?" : "document=?";
    const statements:SqlStatement[]=[
      this.sql.prepare(this.dialect === "mysql" ? "SELECT revision FROM managed_sessions WHERE " + sessionWhere + " FOR UPDATE" : "UPDATE managed_sessions SET revision=revision WHERE " + sessionWhere).bind(...scope),
      // Lock holder/generation/TTL before mutating input on READ COMMITTED adapters.
      this.sql.prepare(this.dialect === "mysql" ? "SELECT id FROM managed_environment_work WHERE " + workWhere + " FOR UPDATE" : "UPDATE managed_environment_work SET claim_generation=claim_generation WHERE " + workWhere)
        .bind(...fence.bindings),
      // PostgreSQL evaluates UPDATE target expressions before waiting for the
      // target tuple lock. Acquire that lock in its own statement so stamps
      // and the next TTL check are evaluated only after the wait completes.
      ...(this.dialect === "sqlite" ? [] : [sequence === null
        ? this.sql.prepare("SELECT id FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=? AND " + rawCas + " FOR UPDATE").bind(claim.workspaceId,claim.sessionId,input.inputId,input.expectedDocument)
        : this.sql.prepare("SELECT sequence FROM managed_session_initial_events WHERE workspace_id=? AND session_id=? AND sequence=? AND " + rawCas + " FOR UPDATE").bind(claim.workspaceId,claim.sessionId,sequence,input.expectedDocument)]),
      sequence === null
        ? this.sql.prepare("UPDATE managed_session_events SET document=" + documentSql + ",processed_at=" + this.clockMs + " WHERE workspace_id=? AND session_id=? AND id=? AND " + rawCas + " AND EXISTS (SELECT 1 FROM managed_sessions WHERE " + sessionWhere + ")")
          .bind(baseDocument,claim.workspaceId,claim.sessionId,input.inputId,input.expectedDocument,...scope)
        : this.sql.prepare("UPDATE managed_session_initial_events SET document=" + documentSql + " WHERE workspace_id=? AND session_id=? AND sequence=? AND " + rawCas + " AND EXISTS (SELECT 1 FROM managed_sessions WHERE " + sessionWhere + ")")
          .bind(baseDocument,claim.workspaceId,claim.sessionId,sequence,input.expectedDocument,...scope),
      this.sql.prepare("UPDATE managed_sessions SET revision=revision+1 WHERE " + sessionWhere).bind(...scope),
    ];
    const conflict=new Error("Work input CAS rejected");
    try {
      if (this.sql.batchChecked) await this.sql.batchChecked(statements, rows=>{if(rows.some((row,index)=>(this.dialect === "mysql" && index<2) || (this.dialect !== "sqlite" && index===2) ? row.results?.length!==1 : row.meta.changes!==1)) throw conflict;});
      else await this.sql.batch(statements.flatMap(statement=>[statement,this.sql.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE abs(-9223372036854775808) END")]));
    } catch(error) {
      if(error===conflict || (!this.sql.batchChecked && error instanceof Error && error.message.includes("integer overflow"))) return rejected;
      throw error;
    }
    return {type:"consumed" as const,inputId:input.inputId,turnId:input.turnId,...(input.consumingTurnId!==undefined?{consumingTurnId:consumer}:{}),boundary:"before_dispatch" as const};
  }
}

/** Native MySQL additive migration. Called at Node composition startup after
 * the structural schema migrator. MySQL DDL auto-commits: preflight BEFORE any
 * ALTER and make each additive step restartable. Never backfill legacy order. */
export async function ensureMysqlWorkInputsSchema(sql: SqlClient): Promise<void> {
  const field = (name: string, minimum: number) => {
    const value = `JSON_EXTRACT(document, '$.source_position.${name}')`;
    return `(CASE WHEN JSON_TYPE(${value}) = 'INTEGER' AND CAST(JSON_UNQUOTE(${value}) AS DECIMAL(65,0)) BETWEEN ${minimum} AND ${maxSafeInteger} THEN CAST(JSON_UNQUOTE(${value}) AS UNSIGNED) ELSE NULL END)`;
  };
  const revision = field("revision", 1);
  const ordinal = field("index", 0);
  const invalid = `(${revision} IS NULL OR ${ordinal} IS NULL)`;
  const legacy = await sql.prepare(`SELECT 1 AS present FROM managed_session_events WHERE ${invalid} LIMIT 1`).first();
  if (legacy) throw new Error("Work input source position migration refused legacy/invalid canonical rows; explicit source-order repair is required (processed_at is not evidence)");
  const duplicate = await sql.prepare(`SELECT 1 AS present FROM managed_session_events GROUP BY workspace_id,session_id,${revision},${ordinal} HAVING COUNT(*) > 1 LIMIT 1`).first();
  if (duplicate) throw new Error("Work input source position migration refused duplicate canonical positions");
  const bootstrapInvalid = `NOT ((${revision} <=> 1) AND (${ordinal} <=> sequence) AND (BINARY JSON_UNQUOTE(JSON_EXTRACT(document, '$.id')) <=> BINARY CONCAT('bootstrap_',session_id,':',sequence)))`;
  for (const [table, columns] of [
    ["managed_session_events", [["work_input_revision", "BIGINT", revision], ["work_input_index", "BIGINT", ordinal], ["work_input_invalid", "TINYINT", invalid]]],
    ["managed_session_initial_events", [["work_input_invalid", "TINYINT", bootstrapInvalid]]],
  ] as const) {
    for (const [name, type, expression] of columns) {
      const read = () => sql.prepare("SELECT generation_expression AS expression, data_type, extra FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?")
        .bind(table,name).first<{expression:string;data_type:string;extra:string}>();
      let existing = await read();
      if (!existing) {
        try { await sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type} GENERATED ALWAYS AS (${expression}) STORED`); }
        catch (error) { if (!mysqlDuplicateDdl(error,1060,"ER_DUP_FIELDNAME")) throw error; }
        existing = await read();
      }
      if (!existing || normalizeMysqlExpression(existing.expression) !== normalizeMysqlExpression(expression) ||
          existing.data_type?.toLowerCase() !== type.toLowerCase() || !/STORED GENERATED/i.test(existing.extra)) {
        throw new Error(`Work input migration: unexpected generated definition for ${table}.${name}`);
      }
    }
  }
  for (const [table,name,columns,unique] of [
    ["managed_session_events",indexName,"workspace_id,session_id,work_input_revision,work_input_index",true],
    ["managed_session_events",invalidIndexName,"workspace_id,session_id,work_input_invalid",false],
    ["managed_session_initial_events",bootstrapInvalidIndexName,"workspace_id,session_id,work_input_invalid",false],
  ] as const) {
    const read = () => sql.prepare("SELECT MIN(non_unique) AS non_unique, GROUP_CONCAT(COALESCE(column_name, '<expression>') ORDER BY seq_in_index) AS columns, MIN(index_type) AS index_type, SUM(CASE WHEN sub_part IS NOT NULL THEN 1 ELSE 0 END) AS prefixes FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? GROUP BY index_name")
      .bind(table,name).first<{non_unique:number;columns:string;index_type:string;prefixes:number}>();
    let existing=await read();
    if (!existing) {
      try { await sql.exec(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON ${table} (${columns})`); }
      catch (error) { if (!mysqlDuplicateDdl(error,1061,"ER_DUP_KEYNAME")) throw error; }
      existing=await read();
    }
    if (!existing || existing.columns!==columns || Number(existing.non_unique)!==(unique?0:1) ||
        existing.index_type!=="BTREE" || Number(existing.prefixes)!==0) throw new Error(`Work input migration: unexpected ${name} definition`);
  }
}

// Ignore ONLY the two additive-DDL name races; connection/privilege/syntax and
// all other failures propagate. A duplicate is never success without catalog proof.
function mysqlDuplicateDdl(error: unknown, errno: number, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  const value=error as {errno?:unknown;code?:unknown};
  return value.errno===errno || value.code===code;
}
function normalizeMysqlExpression(value: string): string {
  const tokens=value.match(/'(?:''|\\.|[^'])*'|`(?:``|[^`])*`|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|<=>|[^\s]/g) ?? [];
  // Catalog spelling can quote identifiers and change keyword case, but string
  // literals (JSON paths, bootstrap prefix) must remain byte-for-byte equal.
  return tokens.map(token=>token.startsWith("'") ? token : token.replace(/`/g, "").toLowerCase()).join("");
}
