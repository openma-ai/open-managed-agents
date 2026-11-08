import { describe, expect, it, vi } from "vitest";
import {
  assertCommandSucceeded,
  checkoutRepository,
  commandScopedRepositoryAccess,
  shellQuote,
} from "../src/session-resource-repository";

const repo = { type: "github_repository" as const, id: "r1", url: "https://g/x.git", mountPath: "/workspace/x", checkout: null };

describe("checkoutRepository", () => {
  it("clones a fresh workspace with git when the sandbox has no native checkout", async () => {
    const exec = vi.fn(async () => "exit=0\n");
    await checkoutRepository({ exec, readFile: async () => { throw new Error("missing"); } }, { ...repo, checkout: { type: "commit", sha: "abcdef0" } });
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "git clone -- 'https://g/x.git' 'x' 2>&1",
      "git -C 'x' config user.name \"Agent\" && git -C 'x' config user.email \"agent@managed-agents.dev\"",
      "git -C 'x' checkout --detach 'abcdef0'",
    ]);
  });

  it("keeps absolute paths under an image WORKDIR", async () => {
    const gitCheckout = vi.fn(async () => undefined);
    const exec = vi.fn(async () => "");
    await checkoutRepository({ exec, gitCheckout, readFile: async () => "", resolveWorkspaceRoot: async () => "/home/app" },
      { ...repo, mountPath: "/home/app/x" });
    expect(gitCheckout).toHaveBeenCalledWith("https://g/x.git", { targetDir: "/home/app/x" });
    expect(exec.mock.calls[0]![0]).toContain("git -C '/home/app/x' config");
  });

  it("verifies and keeps a retained clone; a Bond repository fetches new refs", async () => {
    const exec = vi.fn(async (command: string) => command.includes("get-url") ? "https://g/x.git" : "");
    const gitCheckout = vi.fn();
    await checkoutRepository({ exec, gitCheckout, readFile: async () => "ref: refs/heads/main" },
      { ...repo, credentialSource: "bond", checkout: { type: "commit", sha: "abcdef0" } });
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      "git -C 'x' remote get-url origin",
      "git -C 'x' cat-file -e 'abcdef0^{commit}'",
      "git -C 'x' fetch --quiet --tags --force --prune origin",
    ]);
    expect(gitCheckout).not.toHaveBeenCalled();
  });

  it("fails closed when a retained clone has another origin", async () => {
    await expect(checkoutRepository({ exec: async () => "https://g/other.git", readFile: async () => "ref: x" }, repo))
      .rejects.toThrow(/does not match Session resource r1/);
  });
});

describe("commandScopedRepositoryAccess", () => {
  it("scopes every token to git as an extraHeader", async () => {
    const registerCommandSecrets = vi.fn();
    await commandScopedRepositoryAccess({ registerCommandSecrets }, async () => "ghp_private").prepare([repo]);
    expect(registerCommandSecrets).toHaveBeenCalledWith("git", {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://g/x.git.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3ByaXZhdGU=",
    });
  });

  it("fails closed without command secrets or a token", async () => {
    await expect(commandScopedRepositoryAccess({}, async () => "t").prepare([repo])).rejects.toThrow(/cannot scope repository credentials/);
    await expect(commandScopedRepositoryAccess({ registerCommandSecrets: vi.fn() }, async () => null).prepare([repo]))
      .rejects.toThrow(/credential for resource r1 was not found/);
  });
});

describe("command output", () => {
  it.each(["exit=1\n", "x [exit 2]", "[error: boom]", "[exit signal=9]"])("treats %j as a failure", (output) => {
    expect(() => assertCommandSucceeded("cmd", output)).toThrow(/Repository command failed: cmd/);
  });
  it("quotes single quotes", () => expect(shellQuote("a'b")).toBe("'a'\\''b'"));
});
