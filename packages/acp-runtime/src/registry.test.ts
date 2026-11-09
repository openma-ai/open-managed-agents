import { afterEach, expect, it, vi } from "vitest";
import { _resetRegistryCache, loadRegistry, resolveKnownAgent } from "./registry.js";

afterEach(() => { vi.unstubAllGlobals(); _resetRegistryCache(); });
it("launches our MCP-capable pi adapter even when the official registry has the same id", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ version: 1, agents: [{
    id: "pi-acp", name: "Pi", version: "0.0.34", repository: "https://github.com/svkozak/pi-acp",
    distribution: { npx: { package: "pi-acp@0.0.34" } },
  }] }));
  await loadRegistry({ forceRefresh: true });
  expect(resolveKnownAgent("pi-acp")).toMatchObject({
    spec: { command: "openma-pi-acp" },
    install: { kind: "npm", package: "@openma/pi-acp@0.1.8" },
    homepage: "https://github.com/openma-ai/pi-acp",
  });
});
