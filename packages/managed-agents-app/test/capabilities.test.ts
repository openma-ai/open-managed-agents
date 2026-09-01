import { describe, expect, it } from "vitest";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  httpClientPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";

describe("standard app capability Ports", () => {
  it("injects HTTP as a Port instead of reading global fetch", async () => {
    const http = {
      fetch: async () => new Response("ok"),
    };
    const app = createApp({ modules: [providePort(httpClientPort, http)] });

    expect(app.port(httpClientPort)).toBe(http);
    expect(await (await app.port(httpClientPort).fetch("https://example.test"))
      .text()).toBe("ok");
  });

  it("makes workspace and time explicit application capabilities", () => {
    const workspace = { workspaceId: "workspace-1" };
    const clock = { now: () => new Date("2026-08-26T12:00:00.000Z") };
    const ids = { next: (namespace: string) => `${namespace}-1` };
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, workspace),
        providePort(clockPort, clock),
        providePort(idGeneratorPort, ids),
      ],
    });

    expect(app.port(workspaceContextPort)).toBe(workspace);
    expect(app.port(clockPort)).toBe(clock);
    expect(app.port(idGeneratorPort).next("agent")).toBe("agent-1");
  });
});
