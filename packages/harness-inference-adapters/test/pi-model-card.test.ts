import { expect, it } from 'vitest';
import { resolveProtocolEndpointsFromModelCard } from '@open-managed-agents/inference-proxy';
import { wireHostedInferenceForAcpLaunch } from '../src/wire';
it.each([
 ['ant-compatible','MiniMax-M3.1-Flash',undefined,'anthropic-messages','anthropic'],
 ['custom','wire','openai-responses','openai-responses','openai/v1'],
 ['custom','wire','google-generative-ai','gemini','gemini'],
] as const)('projects Pi card %s %s %s through the host proxy', (providerId,wireModel,api,protocol,path)=>{
 const model={providerId,wireModel,baseUrl:'https://private.test/endpoint',...(api?{piConfig:{api}}:{})};
 const endpoints=resolveProtocolEndpointsFromModelCard(model);
 expect(endpoints).toEqual([{protocol,proxyPathSegment:path,upstreamBaseUrl:model.baseUrl}]);
 const plan=wireHostedInferenceForAcpLaunch({sessionId:'s',gatewayBaseUrl:'https://host.test',sessionsToken:'scoped-token',env:{},agent:{id:'pi-acp',command:'pi-acp'},nativePath:'/native/pi',model});
 const config=JSON.parse(plan.files.find(f=>f.path.endsWith('models.json'))!.content).providers['oma-hosted'];
 expect(config.api).toBe(api??'anthropic-messages');expect(config.baseUrl).toBe('https://host.test/v1/oma/inference-proxy/s/'+path);
 expect(config.apiKey).toBe('$HOSTED_INFERENCE_TOKEN');expect(JSON.stringify(plan.files)).not.toContain('scoped-token');
});
it('uses Pi catalog api and rejects unknown custom cards rather than inventing endpoints',()=>{
 expect(resolveProtocolEndpointsFromModelCard({providerId:'openai',wireModel:'gpt-4o',baseUrl:null}).map(x=>x.protocol)).toEqual(['openai-responses']);
 expect(()=>resolveProtocolEndpointsFromModelCard({providerId:'custom',wireModel:'wire',baseUrl:'https://private.test'})).toThrow('pi_config.api');
});
