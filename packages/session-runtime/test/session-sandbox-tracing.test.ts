import { AsyncLocalStorage } from 'node:async_hooks';
import { expect, it } from 'vitest';
import type { Span, SpanAttributes, SpanOptions, Tracer } from '../../observability/src/types';
import { fakeSessionSandbox, runningRecord } from './fake-session-sandbox-ports';
class RecordingTracer implements Tracer {
 context=new AsyncLocalStorage<string>();
 spans: Array<{name:string;parent?:string;attributes:SpanAttributes;errors:unknown[];status?:number;ends:number}>=[];
 startSpan(name:string,options?:SpanOptions):Span {
  const row={name,parent:this.context.getStore(),attributes:{...options?.attributes},errors:[] as unknown[],status:undefined as number|undefined,ends:0};this.spans.push(row);
  return {setAttribute:(k,v)=>{row.attributes[k]=v;},setAttributes:a=>Object.assign(row.attributes,a),recordException:e=>{row.errors.push(e);},setStatus:s=>{row.status=s.code;},end:()=>{row.ends++;}};
 }
 startActiveSpan<T>(name:string,fn:(s:Span)=>T|Promise<T>,options?:SpanOptions):T|Promise<T>{const span=this.startSpan(name,options);return this.context.run(name,async()=>{try{return await fn(span);}finally{span.end();}});}
}
it('propagates caller context through real open and mount stages without command content',async()=>{
 const tracer=new RecordingTracer(),h=fakeSessionSandbox({tracer});
 await tracer.context.run('dispatch',()=>h.sandbox.mountSessionOutputs());await h.sandbox.exec('SECRET_COMMAND_CONTENT');
 expect(tracer.spans.find(s=>s.name==='session.sandbox.mountSessionOutputs')?.parent).toBe('dispatch');
 expect(tracer.spans.find(s=>s.name==='session.sandbox.open')?.parent).toBe('session.sandbox.mountSessionOutputs');
 for(const stage of ['lookup','plan','acquire','egress.attach','storage.attach'])expect(tracer.spans.some(s=>s.name===`session.sandbox.${stage}`)).toBe(true);
 expect(tracer.spans.find(s=>s.name==='session.sandbox.open')?.attributes).toMatchObject({'session.id':'sess','work.id':'sess','sandbox.runtime_id':'r1','sandbox.provider':'fake'});
 expect(tracer.spans.every(s=>s.ends===1&&s.status===1&&typeof s.attributes.duration_ms==='number')).toBe(true);
 expect(JSON.stringify(tracer.spans)).not.toContain('SECRET_COMMAND_CONTENT');
});
it('records attach failure cause chain without changing rejection or allocating',async()=>{
 const failure=new Error('connect failed',{cause:new Error('transport unavailable')});const tracer=new RecordingTracer();
 const h=fakeSessionSandbox({tracer,saved:runningRecord('r0'),attachErrors:[failure]});
 await expect(h.sandbox.runtime()).rejects.toBe(failure);
 const attach=tracer.spans.find(s=>s.name==='session.sandbox.attach')!;
 expect(attach.status).toBe(2);expect(attach.errors).toHaveLength(2);
 expect(tracer.spans.some(s=>s.name==='session.sandbox.acquire')).toBe(false);expect(h.log).toEqual(['attach:r0']);
 expect(tracer.spans.every(s=>s.ends===1)).toBe(true);
});
it('observes loss, snapshot restore and remount under prepare',async()=>{
 const tracer=new RecordingTracer();const h=fakeSessionSandbox({tracer,saved:runningRecord('r0',{outputs:true,latestSnapshot:{status:'taken',ref:{provider:'fake',kind:'snapshot',ref:'snap'}}}),attachGone:true,resumable:['snap']});
 await h.sandbox.prepare();
 expect(tracer.spans.find(s=>s.name==='session.sandbox.open')?.parent).toBe('session.sandbox.prepare');
 for(const stage of ['restoreFromSnapshot','storage.attach'])expect(tracer.spans.some(s=>s.name===`session.sandbox.${stage}`)).toBe(true);
 expect(tracer.spans.some(s=>s.name==='session.sandbox.acquire')).toBe(false);expect(h.sandbox.restoredFromSnapshot()).toBe(true);
});
it('observes live provider reuse and liveness without allocation',async()=>{
 const tracer=new RecordingTracer();const h=fakeSessionSandbox({tracer,saved:runningRecord('r0')});await h.sandbox.runtime();
 expect(tracer.spans.some(s=>s.name==='session.sandbox.liveness')).toBe(true);
 expect(tracer.spans.find(s=>s.name==='session.sandbox.start')?.attributes['sandbox.decision']).toBe('reuse');
 expect(tracer.spans.some(s=>s.name==='session.sandbox.acquire')).toBe(false);
});
it('keeps provider errors private and rethrows the original cause chain',async()=>{
 const tracer=new RecordingTracer();const failure=new Error('Bearer PRIVATE_TOKEN memory=PRIVATE_BYTES',{cause:new Error('https://user:PRIVATE_PASSWORD@example.test?key=PRIVATE_KEY')});
 const h=fakeSessionSandbox({tracer,saved:runningRecord('r0'),attachErrors:[failure]});
 await expect(h.sandbox.runtime()).rejects.toBe(failure);
 const errors=tracer.spans.flatMap(s=>s.errors as Error[]);
 expect(errors.length).toBeGreaterThan(0);
 expect(errors.map(e=>e.message+' '+e.stack).join('\n')).not.toMatch(/PRIVATE_/);
 expect(failure.cause).toBeInstanceOf(Error);
});
it('ends preparation spans on failure and does not invent storage or Skill stages',async()=>{
 const tracer=new RecordingTracer();const h=fakeSessionSandbox({tracer,preparedBase:'fail'});
 await expect(h.sandbox.runtime()).rejects.toThrow('Environment preparation failed');
 expect(tracer.spans.find(s=>s.name==='session.sandbox.environment.prepare')?.status).toBe(2);
 expect(tracer.spans.some(s=>/storage|skills/.test(s.name))).toBe(false);
 expect(tracer.spans.every(s=>s.ends===1)).toBe(true);
});
it('single-flights concurrent opens without crossing async parent contexts',async()=>{
 const tracer=new RecordingTracer();let unblock!:()=>void;
 const gate=new Promise<void>(resolve=>{unblock=resolve;});
 const h=fakeSessionSandbox({tracer,egressAttach:async()=>gate});
 const first=tracer.context.run('caller1',()=>h.sandbox.runtime());
 const second=tracer.context.run('caller2',()=>h.sandbox.runtime());
 unblock();await Promise.all([first,second]);
 expect(h.log.filter(s=>s==='acquire')).toHaveLength(1);
 expect(tracer.spans.filter(s=>s.name==='session.sandbox.runtime').map(s=>s.parent)).toEqual(['caller1','caller2']);
 expect(tracer.spans.filter(s=>s.name==='session.sandbox.open')).toHaveLength(2);
});
