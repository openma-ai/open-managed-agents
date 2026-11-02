type ResourceRow = {
  type?: string;
  resource: Record<string, unknown>;
};

function nonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Host filesystem path from an explicit `local_path` on a repository resource. */
export function resolveRepositoryLocalPath(rows: ResourceRow[]): string | undefined {
  for (const row of rows) {
    if (row.type !== "github_repository" && row.type !== "github_repo") continue;
    const resource = row.resource;
    const local =
      nonEmptyPath(resource.local_path) ??
      nonEmptyPath(resource.localPath);
    if (local) return local;
  }
  return undefined;
}

export function buildAcpPlatformPromptPrefix(input: {
  systemPrompt: string;
  bundleDir?: string;
}): string {
  const lines = [
    "<openma-acp-platform>",
    "Your process cwd is the project repository. OpenMA platform context (AGENTS.md and skill files) is materialized outside that directory.",
  ];
  if (input.bundleDir) {
    const bundleDir = input.bundleDir;
    lines.push(
      `Read \`${bundleDir}/AGENTS.md\` and any skill files under \`${bundleDir}/.claude/skills/\`, \`${bundleDir}/.opencode/agents/\`, or paths referenced inside AGENTS.md before relying on project-local discovery.`,
    );
  }
  lines.push("", input.systemPrompt, "</openma-acp-platform>", "");
  return lines.join("\n");
}

export function augmentAcpUserPrompt(
  userText: string,
  input: {
    systemPrompt: string;
    projectCwd?: string;
    bundleDir?: string;
    freshSpawn?: boolean;
  },
): string {
  if (!input.projectCwd || !input.freshSpawn) return userText;
  const prefix = buildAcpPlatformPromptPrefix({
    systemPrompt: input.systemPrompt,
    bundleDir: input.bundleDir,
  });
  return `${prefix}${userText}`;
}

export function parseSessionReadyFrame(frame: Record<string, unknown>): {
  bundleDir?: string;
  freshSpawn: boolean;
} {
  const bundleDir = nonEmptyPath(frame.bundle_dir);
  const freshSpawn = frame.fresh === true;
  return { ...(bundleDir ? { bundleDir } : {}), freshSpawn };
}
