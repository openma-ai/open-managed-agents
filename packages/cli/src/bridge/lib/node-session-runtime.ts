import { materializeManagedSkills, configureManagedSkills, managedSkillInstructions, type SkillBinding, type MaterializedSkill } from "./managed-skills.js";
import { spawn as childSpawn } from "node:child_process";

import type { AcpRuntime, SessionOptions } from "@open-managed-agents/acp-runtime";
import { RuntimeSandboxRegistry, runtimePlacement, resolvePlacementRuntime, type RuntimeAttachment } from "./runtime-placement.js";
import { prepareSandboxBundle } from "./sandbox-session-bundle.js";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";

import { setupClaudeConfigDir } from "./claude-config-dir.js";
import { applyOverlayEnv } from "./protected-overlay-env.js";
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

export interface SessionBundle {
  runtime?: RuntimeAttachment;
  managed_skills?: SkillBinding[];
  files: BundleFile[];
  local_skill_blocklist?: string[];
  mcp_servers?: BundleMcpServer[];
  env?: BundleEnvVar[];
}

export function createNodeSessionManagerRuntimeDependencies(): SessionManagerRuntimeDependencies {
  const registry = new RuntimeSandboxRegistry();
  // Key by the agent spec: the common runtime may shallow-copy SessionOptions
  // to add a recovered ACP session id, but preserves this spec on resume.
  const placements = new WeakMap<SessionOptions["agent"], AcpRuntime>();
  const bundleDirs = new Map<string, string>();
  return {
    acpRuntime: {
      start(options) {
        const runtime = placements.get(options.agent);
        if (!runtime) throw new Error("Session placement was not prepared");
        return runtime.start(options);
      },
    },
    async prepareSession(input) {
      const bundle = await fetchSessionBundle(input.environment, input.command.sessionId, input.command.agentId);
      const placement = runtimePlacement(bundle?.runtime, input.command.cwd);
      const scratchDir = await ensureSessionCwd(input.command.sessionId);
      if (placement === "sandbox") {
        const sandbox = await registry.acquire(input.command.sessionId, bundle!.runtime!.runtime_id, scratchDir, process.env, input.scope.id);
        const options = await prepareSandboxBundle(input, bundle!, sandbox, scratchDir);
        placements.set(options.agent, resolvePlacementRuntime(sandbox));
        bundleDirs.set(input.command.sessionId, "/workspace");
        return options;
      }
      const options = await prepareNodeSession(input, bundle);
      placements.set(options.agent, resolvePlacementRuntime());
      bundleDirs.set(input.command.sessionId, scratchDir);
      return options;
    },
    bundleDir: (sessionId) => bundleDirs.get(sessionId),
    async releaseSession(sessionId) {
      // Keep owned sandbox records/files for resume; retention is not M1.
      // Explicit session disposal only stops the ACP process in the common runtime.
      bundleDirs.delete(sessionId);
      if (!registry.owned.has(sessionId)) await removeSessionCwd(sessionId);
    },
  };
}

async function prepareNodeSession(input: SessionManagerPreparationInput, bundle: SessionBundle | null) {
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

  const envFromBundle = applyOverlayEnv({}, Object.fromEntries(
    bundleEnv.map(({ name, value }) => [name, value]),
  ));
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
  url.searchParams.set("agent_id", resolveKnownAgent(agentId)?.id ?? agentId);
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
