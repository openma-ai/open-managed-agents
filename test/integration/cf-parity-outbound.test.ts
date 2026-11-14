import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { installParityModelTransport } from "../fixtures/cf-parity-outbound";

it.each(["request-body", "init-override", "clone"])("non-parity %s preserves the original fetch body semantics", async mode => {
  installParityModelTransport().restore();
  const original = globalThis.fetch;
  const request = new Request("https://non-parity.example/echo", { method: "POST", body: "original-body" });
  const input = mode === "clone" ? request.clone() : request;
  const init = mode === "init-override" ? { method: "PUT", body: "override-body" } : undefined;
  // The receiving fetch consumes the body, just as native fetch does. The
  // fixture must not transfer/lock it first, nor replace the supplied arguments.
  globalThis.fetch = async (actualInput, actualInit) => {
    expect(actualInput).toBe(input);
    expect(actualInit).toBe(init);
    const forwarded = new Request(actualInput, actualInit);
    return Response.json({ method: forwarded.method, body: await forwarded.text() });
  };
  const fixture = installParityModelTransport();
  try {
    const response = await fetch(input, init);
    expect(await response.json()).toEqual({ method: mode === "init-override" ? "PUT" : "POST", body: mode === "init-override" ? "override-body" : "original-body" });
    expect(fixture.calls()).toBe(0);
    if (mode === "clone" || mode === "init-override") expect(await request.text()).toBe("original-body");
  } finally { fixture.restore(); globalThis.fetch = original; }
});

it("target method override refuses without consuming the Request or clone", async () => {
  const fixture = installParityModelTransport();
  const request = new Request("http://parity-model.invalid/v1/messages?beta=true", { method: "PUT", body: "target-body" });
  const clone = request.clone();
  const before = fixture.calls();
  try {
    await expect(fetch(clone, { method: "POST" })).rejects.toThrow("parity model transport refused");
    expect(fixture.calls() - before).toBe(1);
    expect(await clone.text()).toBe("target-body");
    expect(await request.text()).toBe("target-body");
  } finally { fixture.restore(); }
});

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
