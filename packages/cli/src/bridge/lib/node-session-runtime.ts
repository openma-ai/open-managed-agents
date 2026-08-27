import { spawn as childSpawn } from "node:child_process";

import { AcpRuntimeImpl } from "@open-managed-agents/acp-runtime";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";

import { setupClaudeConfigDir } from "./claude-config-dir.js";
import {
  ensureSessionCwd,
  removeSessionCwd,
  writeBundle,
} from "./session-cwd.js";
import type {
  SessionManagerPreparationInput,
  SessionManagerRuntimeDependencies,
} from "./session-manager.js";

interface BundleFile {
  path: string;
  content: string;
}

interface BundleMcpServer {
  name: string;
  type: "http" | "sse";
  url: string;
}

interface BundleEnvVar {
  name: string;
  value: string;
}

interface SessionBundle {
  files: BundleFile[];
  local_skill_blocklist?: string[];
  mcp_servers?: BundleMcpServer[];
  env?: BundleEnvVar[];
}

export function createNodeSessionManagerRuntimeDependencies(): SessionManagerRuntimeDependencies {
  return {
    acpRuntime: new AcpRuntimeImpl(new NodeSpawner()),
    prepareSession: prepareNodeSession,
    releaseSession: removeSessionCwd,
  };
}

async function prepareNodeSession(input: SessionManagerPreparationInput) {
  const agent = resolveKnownAgent(input.command.agentId);
  if (!agent) {
    throw new Error(`unknown ACP agent: ${input.command.agentId}`);
  }
  if (agent.id !== input.command.agentId) {
    process.stderr.write(
      `  ↪ canonicalized acp_agent_id ${input.command.agentId} → ${agent.id} (legacy alias)\n`,
    );
  }

  const onPath = await binaryOnPath(agent.spec.command);
  if (!onPath) {
    throw new Error(
      `binary not on PATH for ${agent.id}: \`${agent.spec.command}\`` +
        (agent.installHint ? `. Install: ${agent.installHint}` : ""),
    );
  }

  const sessionCwd = await ensureSessionCwd(input.command.sessionId);
  let blocklist: string[] = [];
  let bundleMcpServers: BundleMcpServer[] = [];
  let bundleEnv: BundleEnvVar[] = [];
  try {
    const bundle = await fetchSessionBundle(
      input.environment,
      input.command.sessionId,
      agent.id,
    );
    if (bundle) {
      await writeBundle(sessionCwd, bundle.files);
      blocklist = bundle.local_skill_blocklist ?? [];
      bundleMcpServers = bundle.mcp_servers ?? [];
      bundleEnv = bundle.env ?? [];
    }
  } catch (error) {
    process.stderr.write(
      `  ! bundle fetch failed (non-fatal): ${(error as Error).message}\n`,
    );
  }

  const extraEnv: Record<string, string | undefined> = {};
  if (agent.id === "claude-acp") {
    try {
      extraEnv.CLAUDE_CONFIG_DIR = await setupClaudeConfigDir(
        sessionCwd,
        new Set(blocklist),
      );
    } catch (error) {
      process.stderr.write(
        `  ! CLAUDE_CONFIG_DIR setup failed (non-fatal, child sees real ~/.claude): ${(error as Error).message}\n`,
      );
    }
  }

  const envFromBundle: Record<string, string> = {};
  for (const variable of bundleEnv) {
    envFromBundle[variable.name] = variable.value;
  }
  const mcpServers = bundleMcpServers.map((server) => ({
    type: server.type,
    name: server.name,
    url: server.url,
    headers: [{
      name: "Authorization",
      value: `Bearer ${input.scope.agentApiKey}`,
    }],
  }));

  process.stderr.write(
    `  → SessionManager.start ${agent.spec.command} cwd=${sessionCwd}` +
      (extraEnv.CLAUDE_CONFIG_DIR ? ` cfg=${extraEnv.CLAUDE_CONFIG_DIR}` : "") +
      (blocklist.length ? ` blocklist=${blocklist.length}` : "") +
      (mcpServers.length ? ` mcp=${mcpServers.length}` : "") +
      (bundleEnv.length ? ` env=${bundleEnv.length}` : "") +
      "\n",
  );

  return {
    agent: {
      ...agent.spec,
      cwd: sessionCwd,
      env: scrubAcpSpawnEnv({
        ...(agent.spec.env ?? {}),
        ...envFromBundle,
        ...extraEnv,
      }),
    },
    mcpServers,
    resumeAcpSessionId: input.command.acpSessionId,
  };
}

function binaryOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = childSpawn(probe, [command], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function fetchSessionBundle(
  environment: SessionManagerPreparationInput["environment"],
  sessionId: string,
  agentId: string,
): Promise<SessionBundle | null> {
  if (!environment.apiUrl || !environment.runtimeToken) return null;
  const url = new URL(
    `${environment.apiUrl.replace(/\/$/, "")}/agents/runtime/sessions/${encodeURIComponent(sessionId)}/bundle`,
  );
  url.searchParams.set("agent_id", agentId);
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${environment.runtimeToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `bundle ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return (await response.json()) as SessionBundle;
}

function scrubAcpSpawnEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...base,
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    CLAUDE_CODE_SSE_PORT: undefined,
  };
}
