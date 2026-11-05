import { materializeManagedSkills, configureManagedSkills, managedSkillInstructions, type SkillBinding, type MaterializedSkill } from "./managed-skills.js";
import { spawn as childSpawn } from "node:child_process";

import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";

import { setupClaudeConfigDir } from "./claude-config-dir.js";
import {
  acpProcessCwd,
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
  managed_skills?: SkillBinding[];
  files: BundleFile[];
  local_skill_blocklist?: string[];
  mcp_servers?: BundleMcpServer[];
  env?: BundleEnvVar[];
}

export function createNodeSessionManagerRuntimeDependencies(): SessionManagerRuntimeDependencies {
  return {
    acpRuntime: createAcpRuntime({
      type: "local",
      spawner: new NodeSpawner(),
    }),
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

  const scratchDir = await ensureSessionCwd(input.command.sessionId);
  const processCwd = acpProcessCwd(scratchDir, input.command.cwd);
  let blocklist: string[] = [];
  let managedSkills: MaterializedSkill[] = [];
  let bundleMcpServers: BundleMcpServer[] = [];
  let bundleEnv: BundleEnvVar[] = [];
  try {
    const bundle = await fetchSessionBundle(
      input.environment,
      input.command.sessionId,
      agent.id,
    );
    if (bundle) {
      managedSkills = await materializeManagedSkills({
        sessionDir: scratchDir, skills: bundle.managed_skills ?? [],
        apiUrl: input.environment.apiUrl, tenantId: input.scope.id, agentApiKey: input.scope.agentApiKey,
      });
      await writeBundle(scratchDir, bundle.files.map((f) => f.path === "AGENTS.md"
        ? { ...f, content: f.content + managedSkillInstructions(managedSkills) } : f));
      blocklist = bundle.local_skill_blocklist ?? [];
      bundleMcpServers = bundle.mcp_servers ?? [];
      bundleEnv = bundle.env ?? [];
    }
  } catch (error) {
    throw new Error(`Session bundle preparation failed: ${(error as Error).message}`);
  }

  const extraEnv: Record<string, string | undefined> = {};
  if (agent.id === "claude-acp") {
    try {
      extraEnv.CLAUDE_CONFIG_DIR = await setupClaudeConfigDir(
        scratchDir,
        new Set([...blocklist, ...managedSkills.map((s) => s.skill_id)]),
      );
    } catch (error) {
      process.stderr.write(
        `  ! CLAUDE_CONFIG_DIR setup failed (non-fatal, child sees real ~/.claude): ${(error as Error).message}\n`,
      );
    }
  }

  Object.assign(extraEnv, await configureManagedSkills(scratchDir, agent.id, managedSkills, extraEnv.CLAUDE_CONFIG_DIR));

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
    `  → SessionManager.start ${agent.spec.command} cwd=${processCwd}` +
      (processCwd === scratchDir ? "" : ` scratch=${scratchDir}`) +
      (extraEnv.CLAUDE_CONFIG_DIR ? ` cfg=${extraEnv.CLAUDE_CONFIG_DIR}` : "") +
      (blocklist.length ? ` blocklist=${blocklist.length}` : "") +
      (mcpServers.length ? ` mcp=${mcpServers.length}` : "") +
      (bundleEnv.length ? ` env=${bundleEnv.length}` : "") +
      "\n",
  );

  return {
    agent: {
      ...agent.spec,
      cwd: processCwd,
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
  url.searchParams.set("skill_cache", "1");
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
