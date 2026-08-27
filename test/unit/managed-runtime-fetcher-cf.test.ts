import { describe, expect, it } from "vitest";
import { CfManagedRuntimeFetcher } from "../../apps/main/src/lib/cf-managed-runtime-fetcher";

describe("CfManagedRuntimeFetcher", () => {
  it("selects Durable Objects from the complete workspace/session scope", async () => {
    const names: string[] = [];
    const namespace = {
      idFromName(name: string) {
        names.push(name);
        return name;
      },
      get() {
        return {
          fetch: async () => new Response(null, { status: 204 }),
        };
      },
    };
    const fetcher = new CfManagedRuntimeFetcher({
      SESSION_DO: namespace as unknown as DurableObjectNamespace,
    });

    for (const workspaceId of ["workspace_a", "workspace_b"]) {
      const response = await fetcher.fetch(
        "https://managed-runtime/sessions/session_same/event",
        {
          method: "POST",
          headers: { "x-oma-workspace-id": workspaceId },
          body: "{}",
        },
      );
      expect(response.status).toBe(204);
    }

    expect(names).toEqual([
      JSON.stringify(["workspace_a", "session_same"]),
      JSON.stringify(["workspace_b", "session_same"]),
    ]);
  });
});
