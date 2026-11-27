export const DEFAULT_HOSTED_ORIGIN = "https://app.openma.ai";

export interface CliCommands {
  origin: string;
  globalInstall: string;
  loginCommand: string;
  globalQuickstart: string;
  npxCommand: string;
  envOneLiner: string;
  envExports: string;
  verifyCommand: string;
  bridgeSetupCommand: string;
  skillInstallCommand: string;
}

export function resolveConsoleOrigin(rawOrigin?: string | null): string {
  const trimmed = (rawOrigin ?? "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "null") return DEFAULT_HOSTED_ORIGIN;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_HOSTED_ORIGIN;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_HOSTED_ORIGIN;
  }
}

export function buildCliCommands(rawOrigin?: string | null): CliCommands {
  const origin = resolveConsoleOrigin(rawOrigin);
  const globalInstall = "npm i -g @openma/cli";
  const loginCommand = `oma auth login --base-url ${origin}`;
  return {
    origin,
    globalInstall,
    loginCommand,
    globalQuickstart: `${globalInstall} && ${loginCommand}`,
    npxCommand: `npx -y -p @openma/cli oma auth login --base-url ${origin}`,
    envOneLiner: `export OMA_BASE_URL=${origin} OMA_API_KEY=<your-api-key>`,
    envExports: `export OMA_BASE_URL=${origin}\nexport OMA_API_KEY=<your-api-key>`,
    verifyCommand: "oma whoami",
    bridgeSetupCommand: `npx -y -p @openma/cli oma bridge setup --server-url=${origin}`,
    skillInstallCommand: "npx skills add openma-ai/open-managed-agents --skill openma",
  };
}

export interface AgentPromptOptions {
  origin?: string | null;
  productName?: string | null;
  locale?: string | null;
}

export function buildAgentSetupPrompt({
  origin: rawOrigin,
  productName,
  locale,
}: AgentPromptOptions = {}): string {
  const cmds = buildCliCommands(rawOrigin);
  const name = (productName ?? "").trim() || "openma";
  const isZh = (locale ?? "").startsWith("zh");

  if (isZh) {
    return [
      `请帮我连接并使用 ${name} 平台（服务域名：${cmds.origin}）。`,
      "",
      `注意：\`@openma/cli\` 默认指向 ${DEFAULT_HOSTED_ORIGIN}，连接自托管或指定环境时必须传入 \`--base-url\` 或设置 \`OMA_BASE_URL\`；另外 \`npm i -g @openma/cli\` 只会安装 \`oma\` 命令，安装后仍需登录或配置环境变量。`,
      "",
      "请按以下步骤检查并引导我完成配置：",
      "1. 检查本地是否已有 `oma`（`which oma || oma --version`）：",
      `   - 全局安装：\`${cmds.globalInstall}\`（若无全局权限，可改用 \`npx -y -p @openma/cli oma <子命令>\`）`,
      "2. 绑定当前服务域名并完成认证（任选一种）：",
      `   - 浏览器交互登录（推荐，会把 base_url 和凭证写入 \`~/.config/oma/credentials.json\`，后续无需重复配域名；多环境可用 \`--profile <name>\` 隔离）：\`${cmds.loginCommand}\``,
      `   - 无浏览器 / 容器环境（先在 ${cmds.origin}/api-keys 生成 API Key）：`,
      `     \`${cmds.envOneLiner}\``,
      `3. 运行 \`${cmds.verifyCommand}\` 确认当前 \`Base URL\` 为 \`${cmds.origin}\` 且工作区正常。`,
      `4. 如需本地机器桥接（Local Runtime），使用：\`${cmds.bridgeSetupCommand}\``,
      `5. （可选）安装官方 Skill 获取完整用法：\`${cmds.skillInstallCommand}\`；或直接运行 \`oma --help\` 与 \`oma api\` 查看所有命令和 HTTP 接口（如 \`/v1/files\`、\`/v1/sessions/:id/outputs\`）。`,
      "6. 先检查现有资源（`oma models list`、`oma envs list`、`oma agents list`），确认可用环境与模型后再帮我执行任务。",
    ].join("\n");
  }

  return [
    `Help me connect to and use ${name} (base URL: ${cmds.origin}).`,
    "",
    `Important: \`@openma/cli\` defaults to ${DEFAULT_HOSTED_ORIGIN} unless \`--base-url\` or \`OMA_BASE_URL\` is provided, and \`npm i -g @openma/cli\` only installs the \`oma\` binary without authenticating.`,
    "",
    "Please inspect my local environment and guide me through setup:",
    "1. Check if `oma` is installed (`which oma || oma --version`):",
    `   - Global install: \`${cmds.globalInstall}\` (or run without global install via \`npx -y -p @openma/cli oma <subcommand>\`)`,
    "2. Connect to this server (choose one):",
    `   - Interactive browser login (recommended; stores \`base_url\` + token in \`~/.config/oma/credentials.json\` per profile, use \`--profile <name>\` to isolate multiple servers): \`${cmds.loginCommand}\``,
    `   - Headless / API key (create a key at ${cmds.origin}/api-keys):`,
    `     \`${cmds.envOneLiner}\``,
    `3. Verify with \`${cmds.verifyCommand}\` that Base URL is \`${cmds.origin}\` and auth succeeds.`,
    `4. For Local Runtimes bridge setup, use: \`${cmds.bridgeSetupCommand}\``,
    `5. (Optional) Install the \`openma\` skill (\`${cmds.skillInstallCommand}\`), or inspect \`oma --help\` and \`oma api\` (for endpoints without dedicated CLI subcommands like \`/v1/files\` and \`/v1/sessions/:id/outputs\`).`,
    "6. Check existing resources (`oma models list`, `oma envs list`, `oma agents list`) before creating new agents or sessions for my task.",
  ].join("\n");
}
