import {expect,it} from 'vitest';
import {piCustomToolFiles,writePiCustomAnswers} from '../src/pi-custom-tools';
import {createWorkOutputAdapter} from '../src/work-output-adapter';
const definition={type:'custom',name:'approve',description:'approval',input_schema:{type:'object',properties:{}}};
it('rejects collision with an ordinary tool instead of replacing side effects',()=>{
 expect(()=>piCustomToolFiles('/state',[{...definition,name:'bash'}])).toThrow();
 expect(()=>piCustomToolFiles('/state',[definition,definition])).toThrow();
});
it('uses first correlated canonical answer, not orphan or duplicate answers',async()=>{
 let saved='';
 await writePiCustomAnswers({writeFile:async(_,text)=>{saved=text;}},'/results',[
  {id:'call',type:'agent.custom_tool_use',name:'approve',input:{}},
  {id:'orphan',type:'user.custom_tool_result',custom_tool_use_id:'other',content:[{type:'text',text:'wrong'}]},
  {id:'answer',type:'user.custom_tool_result',custom_tool_use_id:'call',content:[{type:'text',text:'yes'}]},
  {id:'duplicate',type:'user.custom_tool_result',custom_tool_use_id:'call',content:[{type:'text',text:'changed'}]},
 ]);
 expect(JSON.parse(saved)).toEqual({call:{content:[{type:'text',text:'yes'}],isError:false}});
});
it('projects a native checkpoint placeholder as a pending custom call, while preserving ordinary result ordering',async()=>{
 const events:any[]=[];
 const adapter=createWorkOutputAdapter({customToolNames:()=>new Set(['approve']),toolUseIdFor:()=>undefined,publish:async batch=>{events.push(...batch);}});
 await adapter.projected([{type:'agent.tool_use',id:'custom',processed_at:'now',name:'approve',input:{}},{type:'agent.tool_use',id:'bash',processed_at:'now',name:'bash',input:{command:'effect'}}]);
 await adapter.projected([{type:'agent.tool_result',id:'ordinary-result',processed_at:'now',tool_use_id:'bash',content:[{type:'text',text:'done'}]}]);
 await adapter.projected([{type:'agent.tool_result',id:'placeholder',processed_at:'now',tool_use_id:'custom',content:[{type:'text',text:JSON.stringify({details:{omaPendingCustom:{toolCallId:'custom',name:'approve'}},content:[{type:'text',text:'Awaiting client tool result'}]})}]}]);
 expect(events.map(e=>[e.type,e.id])).toEqual([['agent.tool_use','bash'],['agent.tool_result','ordinary-result'],['agent.custom_tool_use','custom']]);
});
it('does not turn native argument validation failure into an unanswered external call',async()=>{
 const events:any[]=[];
 const adapter=createWorkOutputAdapter({customToolNames:()=>new Set(['approve']),toolUseIdFor:()=>undefined,publish:async batch=>{events.push(...batch);}});
 await adapter.projected([{type:'agent.tool_use',id:'custom',processed_at:'now',name:'approve',input:{}}]);
 await adapter.projected([{type:'agent.tool_result',id:'invalid',processed_at:'now',tool_use_id:'custom',is_error:true,content:[{type:'text',text:'invalid arguments'}]}]);
 expect(events.map(e=>e.type)).toEqual(['agent.tool_use','agent.tool_result']);
});
