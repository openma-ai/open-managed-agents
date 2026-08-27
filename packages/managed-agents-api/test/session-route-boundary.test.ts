import { describe, expect, it } from "vitest";
import sessionRouteSource from "../src/routes/sessions.ts?raw";

describe("Managed Agents Sessions HTTP adapter boundary", () => {
  it("keeps CRUD and event adapters on separate inbound ports", () => {
    expect(sessionRouteSource).not.toContain("SessionEventsApplicationPort");
    expect(sessionRouteSource).not.toContain("session-events");
    expect(sessionRouteSource).not.toContain("streamSSE");
  });
});
