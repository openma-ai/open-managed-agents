import { expect, it } from "vitest";
import { Sandbox, AuthenticationError, InvalidArgumentError } from "../../../apps/main-node/node_modules/e2b/dist/index.mjs";
import { E2BSandboxExecutor } from "../../sandbox-adapter-e2b/src/e2b";

// Exercise the official SDK start stream and CommandHandle.wait, not a fake
// commands.run rejection pretending to establish dispatch certainty.
it.each([AuthenticationError, InvalidArgumentError])("post-PID %s cannot erase dispatch certainty", async ErrorType => {
  for (const method of ["exec", "run"] as const) {
    let effects = 0;
    const native = new Sandbox({ sandboxId: "offline", envdVersion: "0.3.0", apiKey: "offline-placeholder" });
    Object.assign(native.commands, { rpc: { start: () => (async function* () {
      effects++;
      yield { event: { event: { case: "start", value: { pid: 123 } } } };
      throw new ErrorType("post-PID stream failure");
    })() } });
    const executor = new E2BSandboxExecutor(native as never, {});
    await expect(executor[method]("effect")).rejects.toMatchObject({ outcome: "dispatched_unknown" });
    expect(effects).toBe(1);
  }
});

it.each([AuthenticationError, InvalidArgumentError])("explicit pre-PID start refusal %s stays not dispatched", async ErrorType => {
  const native=new Sandbox({sandboxId:"offline",envdVersion:"0.3.0",apiKey:"offline-placeholder"});
  const rejected=new ErrorType("start refused");
  Object.assign(native.commands,{rpc:{start:()=> (async function*(){throw rejected;})()}});
  await expect(new E2BSandboxExecutor(native as never,{}).exec("effect")).rejects.toBe(rejected);
});
it("real SDK nonzero terminal exit remains an ordinary result", async () => {
  const native=new Sandbox({sandboxId:"offline",envdVersion:"0.3.0",apiKey:"offline-placeholder"});
  Object.assign(native.commands,{rpc:{start:()=> (async function*(){
    yield {event:{event:{case:"start",value:{pid:123}}}};
    yield {event:{event:{case:"end",value:{exitCode:7}}}};
  })()}});
  await expect(new E2BSandboxExecutor(native as never,{}).exec("false")).resolves.toBe("\n[exit 7]");
});
