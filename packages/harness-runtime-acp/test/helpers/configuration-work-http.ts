/** Protocol fixture for launch/native-state unit tests. Their existing Session
 * and history responses remain the test data; expose those records through the
 * private Work contract rather than depending on legacy public polling.
 * Real SQL/fencing is covered by node-supervisor-inputs and CLI tests. */
export function configurationWorkHttp(fetcher: typeof fetch): typeof fetch {
  const rows: Array<{event:Record<string,any>;position:{revision:number;index:number};document:string}> = [];
  const pages = new Map<string,number[]>();
  let loaded = false;
  const prepared = new Set<string>();
  const terminals = new Map<string,object>();
  const stamp = "2026-11-11T00:00:00.000Z";
  return async (raw,init) => {
    const req = new Request(raw,init),url = new URL(req.url);
    const action = url.pathname.split("/").at(-1);
    if (!url.pathname.includes("/v1/oma/sessions/")) return fetcher(raw,init);
    if (action === "inputs-read") {
      const {cursor,limit} = await req.json() as {cursor:string|null;limit:number};
      if (!loaded) {
        const publicUrl = new URL(req.url); publicUrl.pathname=publicUrl.pathname.replace("/v1/oma/sessions/","/v1/sessions/").replace(/inputs-read$/, "events");
        const response=await fetcher(publicUrl.toString(),{headers:req.headers});
        const history=await response.json() as {data:Array<Record<string,any>>};
        for(const original of history.data){
          const {processed_at,...rest}=original;
          const event={...rest,processedAt:rest.type.startsWith("user.")?null:processed_at??null};
          const position={revision:rows.length+1,index:0};
          const document=JSON.stringify({...event,source_position:position});rows.push({event,position,document});
        }
        loaded=true;
      }
      const key=JSON.stringify([cursor,limit]);
      let indices=pages.get(key);
      if(!indices){const start=cursor===null?0:Number(cursor);indices=rows.slice(start,start+limit).map((_,i)=>start+i);pages.set(key,indices);}
      return Response.json({type:"page",rows:indices.map(i=>rows[i]),cursor:indices.length?String(indices.at(-1)!+1):cursor,hasMore:false});
    }
    if(action === "inputs-consume") {
      const body=await req.json() as {inputId:string;turnId:string;expectedDocument:string};const row=rows.find(r=>r.event.id===body.inputId);
      if(!row||row.document!==body.expectedDocument)return Response.json({type:"rejected"},{status:409});
      const prior=JSON.parse(row.document);
      row.event={...row.event,processedAt:stamp};
      row.document=JSON.stringify({...row.event,source_position:{...prior.source_position,consumed_by_execution_id:body.turnId,consumption_claim:{workId:"work_1",generation:1,holder:"fixture"}}});
      return Response.json({type:"consumed",inputId:body.inputId,turnId:body.turnId,boundary:"before_dispatch"});
    }
    if(action === "work-recovery") return Response.json({type:"gap",reason:"consumed_turn_without_terminal",revision:10},{status:409});
    if(action === "work-checkpoint") {const body=await req.json() as {turnId:string;revision:number};prepared.add(body.turnId);return Response.json({type:"prepared",...body});}
    if(action === "work-finalize") {const body=await req.json() as {turnId:string;revision:number;stopReason:{type:string}};if(!prepared.delete(body.turnId))throw Error("Fixture terminal before checkpoint");const terminal={eventId:"terminal-"+body.turnId,turnId:body.turnId,workId:"work_1",generation:1,revision:11,stopReason:body.stopReason};terminals.set(body.turnId,terminal);return Response.json({type:"committed",revision:11,terminal});}
    if(action === "work-publish") {const body=await req.json() as {turnId:string;terminalEventId:string};const terminal=terminals.get(body.turnId);if(!terminal)throw Error("Fixture publication before terminal");return Response.json({type:"published",revision:11,terminal});}
    return fetcher(raw,init);
  };
}
