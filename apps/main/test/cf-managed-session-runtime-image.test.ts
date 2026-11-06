import { describe, expect, it, vi } from "vitest";

// The root vitest config aliases workspace packages to their sources, so
// the mock targets the resolved module path.
vi.mock("../../../packages/managed-agents-adapters-runtime/src/index.ts", () => ({
  encodeRuntimeSessionStart: (input: { sessionId: string }) => ({ session_id: input.sessionId }),
  encodeRuntimeSessionEvent: (event: unknown) => event,
  RuntimeEventStreamDecoder: class {},
}));

import { CfManagedSessionRuntimeAdapter } from "../src/lib/cf-managed-session-runtime";
import { parseCfSandboxImageCatalog } from "../src/lib/cf-sandbox-images";

const catalog = parseCfSandboxImageCatalog(JSON.stringify({
  "fix-git": { reference: "alexgshaw/fix-git:20251031", binding: "SANDBOX_FIX_GIT", workdir: "/app" },
}));

function start(sandboxImage?: string) {
  return {
    workspaceId: "ws_1",
    sessionId: "sess_1",
    session: {},
    environment: { id: "env_1", ...(sandboxImage !== undefined && { openma: { sandboxImage } }) },
    initialEvents: [],
  } as never;
}

function adapter() {
  const bodies: unknown[] = [];
  const runtime = new CfManagedSessionRuntimeAdapter({
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  }, () => catalog);
  return { runtime, bodies };
}

describe("CfManagedSessionRuntimeAdapter sandbox image", () => {
  it("sends the resolved container placement to SessionDO /init", async () => {
    const { runtime, bodies } = adapter();
    await runtime.sessionStarted(start("fix-git"));
    expect(bodies).toEqual([{
      session_id: "sess_1",
      sandbox_image: { alias: "fix-git", binding: "SANDBOX_FIX_GIT", workdir: "/app" },
    }]);
  });

  it("omits it for the default image", async () => {
    const { runtime, bodies } = adapter();
    await runtime.sessionStarted(start());
    expect(bodies).toEqual([{ session_id: "sess_1" }]);
  });

  it("fails the start for an alias the catalog no longer publishes", async () => {
    const { runtime, bodies } = adapter();
    await expect(runtime.sessionStarted(start("retired"))).rejects.toThrow(/Sandbox image "retired" selected by environment env_1/);
    expect(bodies).toEqual([]);
  });
});
