// Cloudflare host side of Session resource mounting (design §0.7): the
// Managed Session input projection served by the main worker over the
// MAIN_MCP service binding, and the CF repository Ports. The mounting itself
// is packages/session-runtime mountSessionResources.

import { logWarn } from "@open-managed-agents/shared";
import { assertCommandSucceeded, type RepositoryAccessPort, type SessionResourceRecord } from "@open-managed-agents/session-runtime";
import type { SandboxExecutor } from "@open-managed-agents/agent-harness";

export interface ManagedSessionFileSource {
  downloadFile(fileId: string): Promise<{ content: Uint8Array }>;
}

export interface ManagedSessionResourceSource {
  resolveManagedSessionInputs(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<
    | { type: "found"; session: { resources: readonly SessionResourceRecord[] } }
    | { type: "not_found" }
  >;
  downloadManagedSessionFile(input: {
    tenantId: string;
    sessionId: string;
    fileId: string;
  }): Promise<{ type: "found"; content: Uint8Array } | { type: "not_found" }>;
  materializeManagedMemorySnapshot(input: {
    tenantId: string;
    sessionId: string;
    memoryStoreId: string;
    access: "read_only" | "read_write";
    runtimeGeneration?: string;
  }): Promise<{ type: "found"; mountStoreId: string } | { type: "not_found" }>;
}

/** The current canonical resources, each Memory Store resolved to the
 * snapshot prefix this runtime generation mounts, plus a Session-scoped
 * file source. */
export async function loadManagedSessionResources(
  source: ManagedSessionResourceSource,
  input: { tenantId: string; sessionId: string; runtimeGeneration?: string },
): Promise<{ resources: Array<Record<string, unknown> & { type: string }>; fileSource: ManagedSessionFileSource }> {
  const resolved = await source.resolveManagedSessionInputs(input);
  if (resolved.type !== "found") throw new Error(`Managed Session ${input.sessionId} was not found`);
  const resources: Array<Record<string, unknown> & { type: string }> = [];
  for (const resource of resolved.session.resources) {
    if (resource.type !== "memory_store") {
      resources.push({ ...resource });
      continue;
    }
    const memoryStoreId = typeof resource.memoryStoreId === "string"
      ? resource.memoryStoreId
      : typeof resource.memory_store_id === "string" ? resource.memory_store_id : "";
    if (memoryStoreId.length === 0) throw new Error("Managed Session Memory Store resource requires memory_store_id");
    const access = resource.access === "read_only" ? "read_only" : "read_write";
    const snapshot = await source.materializeManagedMemorySnapshot({ ...input, memoryStoreId, access });
    if (snapshot.type !== "found") throw new Error(`Managed Session Memory Store ${memoryStoreId} was not found`);
    resources.push({ ...resource, runtimeMountStoreId: snapshot.mountStoreId });
  }
  return {
    resources,
    fileSource: {
      downloadFile: async (fileId) => {
        const downloaded = await source.downloadManagedSessionFile({ ...input, fileId });
        if (downloaded.type !== "found") throw new Error(`Managed Session file ${fileId} was not found`);
        return { content: downloaded.content };
      },
    },
  };
}

/** CF repository access: the agent worker's outbound proxy injects
 * Authorization on every github.com / api.github.com request
 * (oma-sandbox.ts githubAuthHandler), so no token enters the container. Git
 * is set to fail fast instead of prompting when the proxy cannot resolve one:
 * no askpass, no credential helper, so the proxy is the only auth path. A
 * repository without a token passes the proxy unauthenticated (anonymous). */
export function proxiedRepositoryAccess(sandbox: Pick<SandboxExecutor, "exec">): RepositoryAccessPort {
  return {
    anonymous: (repository) => repository.credentialSource === "bond",
    async prepare() {
      const command = `git config --global core.askpass /bin/true && `
        + `git config --global credential.helper "" && `
        + `(git config --global --unset-all credential.helper 2>/dev/null || true)`;
      assertCommandSucceeded(command, await sandbox.exec(command, 5000));
    },
  };
}

/** Installs the GitHub CLI once a repository is mounted. Best effort: the
 * agent can still use git + curl. */
export async function installGhCli(sandbox: Pick<SandboxExecutor, "exec">): Promise<void> {
  try {
    const check = await sandbox.exec("which gh 2>/dev/null && echo OK || echo MISSING", 5000);
    if (check.includes("OK")) return;
    await sandbox.exec(
      `(type -p wget >/dev/null || (apt-get update && apt-get install wget -y -qq)) && `
      + `mkdir -p -m 755 /etc/apt/keyrings && `
      + `wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && `
      + `chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && `
      + `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && `
      + `apt-get update -qq && apt-get install gh -y -qq 2>&1`,
      120000,
    );
  } catch (err) {
    logWarn({ op: "resource.gh_cli_install", err }, "gh CLI install failed; agent will fall back to git + curl");
  }
}
