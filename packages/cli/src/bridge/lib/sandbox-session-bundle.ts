import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import type { SessionOptions } from "@open-managed-agents/acp-runtime";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";
import { safeSkillArchivePath } from "@open-managed-agents/acp-runtime/skill-package";
import { parseExecResult } from "@open-managed-agents/sandbox";
import { materializeManagedSkills, managedSkillInstructions } from "./managed-skills.js";
import type { RuntimeSandbox } from "./runtime-placement.js";
import type { SessionBundle } from "./node-session-runtime.js";
import type { SessionManagerPreparationInput } from "./session-manager.js";
import { applyOverlayEnv } from "./protected-overlay-env.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Copy selected immutable packages out of ~/.oma/cache/skills via the file
 * API. Host custom directories must NEVER be mounted for sandbox placement.
 * Each LiteBox receives only this session's selected packages. */
export async function prepareSandboxBundle(
  input: SessionManagerPreparationInput, bundle: SessionBundle, sandbox: RuntimeSandbox, scratchDir: string,
): Promise<SessionOptions> {
  const agent = resolveKnownAgent(input.command.agentId);
  if (!agent) throw new Error(`unknown ACP agent: ${input.command.agentId}`);
  const skills = await materializeManagedSkills({
    sessionDir: scratchDir, skills: bundle.managed_skills ?? [],
    apiUrl: input.environment.apiUrl, tenantId: input.scope.id, agentApiKey: input.scope.agentApiKey,
  });
  const run = async (command: string) => {
    const result = parseExecResult(await sandbox.exec(command));
    if (result.exitCode !== 0) throw new Error("Sandbox bundle preparation command failed");
  };
  const copied = [];
  for (const skill of skills) {
    const key = createHash("sha256").update(skill.cachePath).digest("hex");
    const cachePath = `/oma/cache/skills/${key}`;
    // Re-copying on resume is intentional for M1; the host cache avoids downloads.
    await run(`mkdir -p ${quote(cachePath)} && chmod -R u+w ${quote(cachePath)}`);
    await copyTree(skill.cachePath, cachePath, sandbox);
    await run(`chmod -R a-w ${quote(cachePath)}`);
    const linkPath = `/workspace/skills/${safeSkillArchivePath(skill.skill_id)}`;
    await run(`mkdir -p /workspace/skills && ln -sfn ${quote(cachePath)} ${quote(linkPath)}`);
    copied.push({ ...skill, cachePath, linkPath });
    if (agent.id === "claude-acp") {
      const root = posix.dirname(posix.join(cachePath, skill.manifests[0]));
      await run(`mkdir -p /workspace/.claude-config/skills && ln -sfn ${quote(root)} ${quote(`/workspace/.claude-config/skills/${skill.skill_id}`)}`);
    }
  }
  for (const file of bundle.files) {
    const path = safeSkillArchivePath(file.path);
    if (path.startsWith("skills/") || path.startsWith(".oma-")) throw new Error("Bundle cannot overwrite managed skill state");
    await sandbox.writeFile(`/workspace/${path}`, file.content + (path === "AGENTS.md" ? managedSkillInstructions(copied) : ""));
  }
  // Never probe the host PATH or import host ~/.claude into the jail. Operators
  // supply a prepared SANDBOX_IMAGE containing the selected ACP binary + Node.
  await run(`command -v ${quote(agent.spec.command)} >/dev/null`);
  const env = applyOverlayEnv({}, Object.fromEntries(
    (bundle.env ?? []).map(({ name, value }) => [name, value]),
  ));
  return {
    agent: {
      ...agent.spec,
      cwd: "/workspace",
      env: {
        ...agent.spec.env, ...env,
        ...(agent.id === "claude-acp" ? { CLAUDE_CONFIG_DIR: "/workspace/.claude-config" } : {}),
        ...(skills.length ? { OPENMA_SKILLS_DIR: "/workspace/skills" } : {}),
        CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_CODE_SSE_PORT: undefined,
      },
    },
    mcpServers: (bundle.mcp_servers ?? []).map((server) => ({
      ...server, headers: [{ name: "Authorization", value: `Bearer ${input.scope.agentApiKey}` }],
    })),
    resumeAcpSessionId: input.command.acpSessionId,
  };
}

async function copyTree(source: string, destination: string, sandbox: RuntimeSandbox): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = posix.join(destination, safeSkillArchivePath(entry.name));
    if (entry.isDirectory()) await copyTree(from, to, sandbox);
    else if (entry.isFile()) {
      if (!sandbox.writeFileBytes) throw new Error("Sandbox requires binary file writes for skill cache copies");
      await sandbox.writeFileBytes(to, await readFile(from));
    }
    else throw new Error("Skill cache copy refuses links and special files");
  }
}
