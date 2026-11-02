import { describe, expect, expectTypeOf, it } from "vitest";
import { OpenMA, type OmaHarnessCatalog } from "../src/index.js";

describe("harness discovery", () => {
  it("uses the authenticated extension path and preserves the public catalog contract", async () => {
    let request: Request | undefined;
    const client = new OpenMA({
      apiKey: "catalog-test-key", activeTenantId: "catalog-tenant", baseURL: "https://openma.test", maxRetries: 0,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ object: "list", data: [{
          id: "custom", label: "Custom", description: "Custom host loop",
          execution: { placement: "host" }, capabilities: { runtime_binding: true }, requirements: [],
        }], default_harness_id: "custom" });
      },
    });
    const catalog = await client.oma.harnesses.list();
    expectTypeOf(catalog).toExtend<OmaHarnessCatalog>();
    expect(request?.method).toBe("GET");
    expect(new URL(request!.url).pathname).toBe("/v1/oma/harnesses");
    expect(request?.headers.get("x-api-key")).toBe("catalog-test-key");
    expect(request?.headers.get("x-active-tenant")).toBe("catalog-tenant");
    expect(catalog).toEqual({ object: "list", data: [{
      id: "custom", label: "Custom", description: "Custom host loop",
      execution: { placement: "host" }, capabilities: { runtime_binding: true }, requirements: [],
    }], default_harness_id: "custom" });
  });
});
