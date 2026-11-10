import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { installParityModelTransport } from "../fixtures/cf-parity-outbound";

it("preserves exact model transport refusal in both main and DO contexts", async () => {
  const fixture = installParityModelTransport();
  const before = fixture.calls();
  try {
    await expect(fetch("http://parity-model.invalid/v1/messages", {method:"POST", body:"{}"})).rejects.toThrow("parity model transport refused");
    expect(fixture.calls() - before).toBe(1);
    await expect(fetch("http://parity-model.invalid/wrong", {method:"POST", body:"{}"})).rejects.toThrow("Unexpected parity model endpoint");
    expect(fixture.calls() - before).toBe(1);
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName("parity-outbound-contract"));
    await runInDurableObject(stub, async () => {
      const { installParityModelTransport } = await import("../fixtures/cf-parity-outbound");
      const local = installParityModelTransport();
      const before = local.calls();
      try {
        await expect(fetch("http://parity-model.invalid/v1/messages", {method:"POST", body:"{}"})).rejects.toThrow("parity model transport refused");
        expect(local.calls() - before).toBe(1);
      } finally { local.restore(); }
    });
  } finally { fixture.restore(); }
});
