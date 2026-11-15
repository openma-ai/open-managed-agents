import { expect, it } from 'vitest';
import { prepareEnvironmentBuildSandbox } from '../../../packages/control-plane-node/src/lib/environment-cache';
import { prepareCloudflareEnvironmentRuntime } from '../src/runtime/cloudflare-environment-cache';

const hosts = {
 node: (runtime: {exec(command:string):Promise<string>}, registry: string) => prepareEnvironmentBuildSandbox(runtime as never,
   {environment:{id:'env',config:{type:'cloud',packages:{}}},acpRegistry:registry},'session'),
 cloudflare: (runtime: {exec(command:string):Promise<string>}, registry: string) => prepareCloudflareEnvironmentRuntime({runtime,
   setup:{environmentId:'env',packages:{},acpRegistry:registry},sessionId:'session'}),
};
for(const [host,prepare] of Object.entries(hosts)) {
 it.each(['pi-acp@0.1.8','codex-acp@1.8.0'])(`${host} Environment prepares the shared pinned plan and inventory: %s`, async registry=>{
  const [id,version]=registry.split('@');const command=`/home/agent/.oma/installed-agent/${id}/${version}/acp-launch.sh`;const calls:string[]=[];
  const prepared=await prepare({exec:async script=>{calls.push(script);return `OMA_ACP_LAUNCHER=${command}\nOMA_ACP_INSTALL_OK`; }},registry);
  const installs=calls.filter(script=>script.includes("OMA_ACP_INSTALL_OK"));
  expect(installs).toHaveLength(1);expect(installs[0]).toContain(version);
  expect(prepared?.harness).toEqual({id,version});expect(prepared?.launch.command).toBe(command);
  expect(JSON.parse(prepared!.inventory)).toEqual([expect.objectContaining({id,version,command})]);
 });
 it(`${host} rejects unpinned references before execution`,async()=>{
  let calls=0;await expect(prepare({exec:async()=>{calls++;return ''}},'pi-acp@latest')).rejects.toThrow();expect(calls).toBe(0);
 });
 it.each(['','OMA_ACP_LAUNCHER=/home/agent/.oma/installed-agent/pi-acp/9.9.9/acp-launch.sh\nOMA_ACP_INSTALL_OK'])(`${host} rejects a missing install or mismatched version`,async output=>{
  await expect(prepare({exec:async()=>output},'pi-acp@0.1.8')).rejects.toThrow(/install|version/);
 });
}
