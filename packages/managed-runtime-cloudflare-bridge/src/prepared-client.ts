import type { EnvironmentSnapshotRef } from "@open-managed-agents/sandbox";
import { CloudflareBridgeRuntime, type CloudflareBridgeProviderOptions } from "./cloudflare-bridge";

/** Transport only for the prepared bridge protocol. Not advertised by the
 * ordinary provider: deployment requires separately reviewed server support
 * and an execution-scoped trusted egress binder before Session use. */
export interface CloudflareBridgePreparedClientOptions extends CloudflareBridgeProviderOptions {
  /** Operator-trusted container.images.sandbox provenance, never a response-derived value. */
  expectedImage: string;
}

export function createCloudflareBridgePreparedClient(options: CloudflareBridgePreparedClientOptions) {
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(options.expectedImage)) throw new Error("Prepared bridge requires an expected digest-pinned image");
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/g, "") + "/v1/sandbox";
  const request = async (suffix: string, method: string, body: unknown) => {
    const response = await fetch(base + suffix, { method, headers: { authorization: "Bearer " + options.apiKey, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
      let code: unknown; try { code = (await response.json() as { code?: unknown }).code; } catch { /* status remains authoritative */ }
      throw Object.assign(new Error("Prepared bridge request failed (" + response.status + ")"), { code, status: response.status });
    }
    return response;
  };
  const allocate = async (body: unknown) => {
    const response = await request("", "POST", body);
    const result = await response.json() as { id?: unknown };
    if (typeof result.id !== "string" || !result.id) throw new Error("Prepared bridge returned an invalid runtime id");
    const runtime = new CloudflareBridgeRuntime({ ...options, runtimeId: result.id });
    try {
      const recorded = await options.checkpointStore.put((options.checkpointKeyPrefix ?? "cloudflare-bridge-workspaces").replace(/^\/+|\/+$/g, "") + "/allocations/" + encodeURIComponent(result.id) + ".json", JSON.stringify(runtime.runtimeHandle()));
      if (!recorded) throw new Error("Prepared bridge allocation was not persisted");
      await request("/" + encodeURIComponent(result.id) + "/claim", "POST", {});
      return runtime;
    } catch (error) { await runtime.destroy(); throw error; }
  };
  const path = (runtime: CloudflareBridgeRuntime) => "/" + encodeURIComponent(runtime.runtimeHandle().runtimeId);
  return {
    createBuild(input: { workspaceId: string; firewall: unknown }) {
      return allocate({ purpose: "environment-build", workspace_id: input.workspaceId, from: { image: "sandbox" }, firewall: input.firewall });
    },
    async applyBuildFirewall(runtime: CloudflareBridgeRuntime, firewall: unknown): Promise<void> {
      await request(path(runtime) + "/firewall", "PUT", firewall);
    },
    /** The server supports public host allowlists only, not open/CIDR egress
     * or execution-token authorization. Keep credential relay wiring separate. */
    async applySessionFirewall(runtime: CloudflareBridgeRuntime, input: {
      workspaceId: string;
      rules: { mode: string; allowHosts: readonly string[]; allowCidrs: readonly string[]; denyAlways: readonly string[]; includesGateway: boolean };
    }): Promise<void> {
      if (!input.workspaceId || input.rules.mode !== "allowlist" || input.rules.allowCidrs.length !== 0) throw new Error("Prepared Session firewall requires a public allowlist without CIDRs");
      await request(path(runtime) + "/firewall", "PUT", {
        workspace_id: input.workspaceId, runtime_id: runtime.runtimeHandle().runtimeId, rules: input.rules,
      });
    },
    async snapshotEnvironment(runtime: CloudflareBridgeRuntime, name: string): Promise<EnvironmentSnapshotRef> {
      const response = await request(path(runtime) + "/environment-snapshot", "POST", { name });
      const result = await response.json() as { ref?: unknown; id?: unknown; size?: unknown; image?: unknown };
      if (typeof result.ref !== "string" || !result.ref || typeof result.id !== "string" || !result.id || typeof result.size !== "number" || !Number.isSafeInteger(result.size) || result.size < 0 || result.image !== options.expectedImage) throw new Error("Prepared bridge returned an invalid native snapshot");
      return { adapter: "cloudflare-sandbox-bridge", ref: result.ref };
    },
    async restoreEnvironment(input: { workspaceId: string; snapshot: EnvironmentSnapshotRef; bindSessionEgress?: (runtime: CloudflareBridgeRuntime) => Promise<void> }): Promise<CloudflareBridgeRuntime> {
      if (!input.bindSessionEgress) throw new Error("Prepared restore requires a trusted execution-scoped Session egress binder");
      if (input.snapshot.adapter !== "cloudflare-sandbox-bridge") throw new Error("Incompatible prepared snapshot adapter");
      const runtime = await allocate({ purpose: "session", workspace_id: input.workspaceId, from: { environment_snapshot: input.snapshot.ref } });
      try { await input.bindSessionEgress(runtime); return runtime; }
      catch (error) { await runtime.destroy(); throw error; }
    },
  };
}
