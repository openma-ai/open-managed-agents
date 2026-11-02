import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildSandboxImageRoutes } from "../src/sandbox-images";

describe("GET /v1/oma/sandbox_images", () => {
  it("lists aliases, labels, and descriptions without provider references", async () => {
    const app = new Hono();
    app.route("/v1/oma/sandbox_images", buildSandboxImageRoutes({
      list: () => [
        { alias: "analytics", label: "Analytics", description: "pandas + Claude ACP" },
        { alias: "bare", label: "bare", description: null },
      ],
    }));
    const response = await app.request("/v1/oma/sandbox_images");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        { type: "sandbox_image", alias: "analytics", label: "Analytics", description: "pandas + Claude ACP" },
        { type: "sandbox_image", alias: "bare", label: "bare", description: null },
      ],
    });
  });

  it("returns an empty list when the deployment publishes no catalog", async () => {
    const response = await buildSandboxImageRoutes({ list: () => [] }).request("/");
    expect(await response.json()).toEqual({ data: [] });
  });
});
