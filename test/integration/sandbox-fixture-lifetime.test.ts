import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("test container lifetime survives owner DO eviction until explicit destroy", async () => {
  const stub = env.SANDBOX.get(env.SANDBOX.idFromName(`fixture-lifetime-${crypto.randomUUID()}`)) as any;
  try {
    await stub.provision({incarnation:"physical-runtime",mounts:[{mountPath:"/mnt/session/outputs"}]});
    await stub.exec("echo generation-one > /tmp/.oma-warm");
    await evictDurableObject(stub);
    expect(await stub.describe()).toEqual({running:true,incarnation:"physical-runtime",mounts:["/mnt/session/outputs"]});
    expect((await stub.exec("cat /tmp/.oma-warm")).stdout).toBe("generation-one\n");
    expect((await stub.createContainerSnapshot()).id).toBe("stub-rootfs-physical-runtime");
    await stub.destroy();
    await evictDurableObject(stub);
    expect((await stub.describe()).running).toBe(false);
  } finally {await stub.destroy();}
});
