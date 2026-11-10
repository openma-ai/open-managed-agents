import { expect, it, vi } from "vitest";
import { createE2BSessionSandbox } from "../src/runtime/e2b-session-sandbox";
const observed = vi.hoisted(() => ({ commands: [] as { command: string; user?: string }[], writes: [] as { path: string; user?: string; content: string }[], files: new Map<string, string>(), networks: [] as {allowOut?:string[]}[] }));
vi.mock("e2b", () => ({ Sandbox: {
  create: async () => ({ sandboxId: "physical", kill: async () => {}, updateNetwork: async (network: {allowOut?:string[]}) => { observed.networks.push(network); },
    commands: { run: async (command: string, options: { user?: string } = {}) => { observed.commands.push({ command, user: options.user }); return { exitCode: 0, stdout: command.startsWith("cat ") ? "generation" : "", stderr: "" }; } },
    files: {
      write: async (path: string, content: string, options: { user?: string } = {}) => { observed.writes.push({path, content, user: options.user}); observed.files.set(path, content); if(path.endsWith(".go")) observed.files.set(path.replace(/\.go$/, ".response.json"), JSON.stringify({ok:true,id:"native",epoch:"epoch",pid:19})); },
      read: async (path: string) => path.endsWith("/ready") ? "oma-managed-v2" : observed.files.get(path),
    },
  }),
} }));
function build(workAuthority?: unknown, limited = false) {
  const record = new Map();
  return createE2BSessionSandbox({ env: {E2B_API_KEY:"provider-key",E2B_TEMPLATE:"trusted",E2B_MAX_LIFETIME_MS:"3600000",PUBLIC_BASE_URL:"https://control.test",MEMORY_BUCKET:{} as never,FILES_BUCKET:{} as never},
    storage:{kv:{get:(key:string)=>record.get(key),put:(key:string,value:unknown)=>record.set(key,value)}} as never,
    scope:()=>({workspaceId:"ws",environmentId:"env",sessionId:"sess",workId:"work"}), networking:async()=>limited?{type:"limited",allowed_hosts:[]}:undefined, fence:()=>undefined, relayToken:async()=>"not-used", ...(workAuthority ? {workAuthority} : {}),
  });
}
it("ordinary E2B commands run as oma-worker while setup alone is root", async () => {
  observed.commands.length=0;
  await build().exec("agent-command");
  expect(observed.commands.find(call=>call.command==="agent-command")?.user).toBe("oma-worker");
  expect(observed.commands.find(call=>call.command.startsWith("mkdir -p"))?.user).toBe("root");
});
it("Work authority is checked before any E2B acquire when the claim has been lost", async () => {
  const sandbox=build({attempt:{workspaceId:"ws",sessionId:"sess",executionId:"work",attemptId:"environment-work-claim:3",ownerId:"env",generation:3},isCurrent:async()=>false,token:async()=>"token"});
  observed.commands.length=0;
  await expect(sandbox.runtime()).rejects.toThrow(/fence/);
  expect(observed.commands).toEqual([]);
});
it("limited Work networking always permits its canonical HTTP control-plane channel",async()=>{
 observed.networks.length=0;
 await build({attempt:{workspaceId:"ws",sessionId:"sess",executionId:"work",attemptId:"environment-work-claim:3",ownerId:"env",generation:3},isCurrent:async()=>true,token:async()=>"token"},true).runtime();
 expect(observed.networks.at(-1)?.allowOut).toContain("control.test");
});
it("trusted managedBootstrap exposes Files native launch, never an SDK shell launch", async () => {
  const runtime=await build().runtime(); observed.writes.length=0; observed.commands.length=0;
  await runtime.startManagedProcess({command:"/usr/local/bin/node",args:["/opt/oma-managed/worker/node-e2b-work-item-cli.js"],env:{}},{workspaceId:"ws",sessionId:"sess",workId:"work",attemptId:"environment-work-claim:3"});
  expect(observed.commands).toEqual([]);
  const request=observed.writes.find(call=>call.path.endsWith(".json"))!;
  expect(request.user).toBe("root"); expect(JSON.parse(request.content)).toMatchObject({op:"start",identity:{workspaceId:"ws",sessionId:"sess",workId:"work",attemptId:"environment-work-claim:3"}});
});
