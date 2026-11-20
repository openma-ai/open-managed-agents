import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOSTED_ORIGIN,
  buildAgentSetupPrompt,
  buildCliCommands,
  resolveConsoleOrigin,
} from "./cli-onboarding";

describe("cli-onboarding", () => {
  it("normalizes browser origins and falls back to the hosted default", () => {
    expect(resolveConsoleOrigin(undefined)).toBe(DEFAULT_HOSTED_ORIGIN);
    expect(resolveConsoleOrigin("null")).toBe(DEFAULT_HOSTED_ORIGIN);
    expect(resolveConsoleOrigin("ftp://bad.example")).toBe(DEFAULT_HOSTED_ORIGIN);
    expect(resolveConsoleOrigin("https://oma.example.com///")).toBe("https://oma.example.com");
  });

  it("builds CLI login, env, bridge, and skill commands bound to the console origin", () => {
    const cmds = buildCliCommands("https://oma.example.com/dashboard");
    expect(cmds.origin).toBe("https://oma.example.com");
    expect(cmds.globalQuickstart).toBe(
      "npm i -g @openma/cli && oma auth login --base-url https://oma.example.com",
    );
    expect(cmds.npxCommand).toBe(
      "npx -y -p @openma/cli oma auth login --base-url https://oma.example.com",
    );
    expect(cmds.envOneLiner).toBe(
      "export OMA_BASE_URL=https://oma.example.com OMA_API_KEY=<your-api-key>",
    );
    expect(cmds.bridgeSetupCommand).toBe(
      "npx -y -p @openma/cli oma bridge setup --server-url=https://oma.example.com",
    );
    expect(cmds.skillInstallCommand).toBe(
      "npx skills add openma-ai/open-managed-agents --skill openma",
    );
  });

  it("builds bilingual setup prompts with origin, profile, and verification steps", () => {
    const en = buildAgentSetupPrompt({
      origin: "https://oma.example.com",
      productName: "Acme Agents",
      locale: "en",
    });
    expect(en).toContain("Help me connect to and use Acme Agents (base URL: https://oma.example.com).");
    expect(en).toContain("oma auth login --base-url https://oma.example.com");
    expect(en).toContain("oma whoami");
    expect(en).toContain("--profile <name>");
    expect(en).toContain("npx skills add openma-ai/open-managed-agents --skill openma");

    const zh = buildAgentSetupPrompt({
      origin: "https://oma.example.com",
      productName: "Acme Agents",
      locale: "zh-CN",
    });
    expect(zh).toContain("请帮我连接并使用 Acme Agents 平台（服务域名：https://oma.example.com）。");
    expect(zh).toContain("export OMA_BASE_URL=https://oma.example.com OMA_API_KEY=<your-api-key>");
    expect(zh).toContain("oma bridge setup --server-url=https://oma.example.com");
  });
});
