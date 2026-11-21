import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import mainApp from "../../apps/main/src/index";
import { CLOUDFLARE_HARNESS_CATALOG } from "../../apps/main/src/routes/harnesses";

describe("Cloudflare harness catalog route", () => {
  it("exposes the same registered deployment catalog used by the agent worker", async () => {
    const request = new Request("http://localhost/v1/oma/harnesses", {
      headers: { "x-api-key": "test-key" },
    });
    const response = await mainApp.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CLOUDFLARE_HARNESS_CATALOG);
  });
});
