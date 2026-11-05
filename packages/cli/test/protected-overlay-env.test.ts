import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOverlayEnv, isProtectedOverlayEnvKey } from "../src/bridge/lib/protected-overlay-env.js";

afterEach(() => vi.restoreAllMocks());

describe("protected overlay env", () => {
  it.each([
    "PATH", "HOME", "USER", "SHELL", "TERM", "TMPDIR", "TMP", "TEMP",
    "CLAUDE_CONFIG_DIR", "OPENMA_SKILLS_DIR",
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
    "OMA_", "OMA_PROFILE", "OMA_FUTURE_KEY",
  ])("ignores %s case-insensitively, preserving host/daemon values", (name) => {
    const target = { [name]: "host-or-daemon" };
    const warn = vi.fn();
    const variants = [name, name.toLowerCase(), name[0] + name.slice(1).toLowerCase()];
    for (const key of variants) {
      expect(isProtectedOverlayEnvKey(key)).toBe(true);
      expect(applyOverlayEnv(target, { [key]: "overlay-secret" }, { warn })).toBe(target);
      expect(target).toEqual({ [name]: "host-or-daemon" });
      expect(warn).toHaveBeenLastCalledWith(key);
    }
    expect(warn).toHaveBeenCalledTimes(variants.length);
  });

  it("omits protected keys even when absent from the target", () => {
    const warn = vi.fn();
    expect(applyOverlayEnv({}, { Home: "ignored", oMa_TOKEN: "ignored" }, { warn })).toEqual({});
    expect(warn.mock.calls).toEqual([["Home"], ["oMa_TOKEN"]]);
  });

  it("keeps non-protected Environment and session precedence, including empty values", () => {
    const warn = vi.fn();
    const target = { PATH: "/host/bin", COLOR: "host", HOST_ONLY: "yes" };
    applyOverlayEnv(target, { PATH: "/environment/bin", COLOR: "environment", ENV_ONLY: "yes" }, { warn });
    applyOverlayEnv(target, { PATH: "/session/bin", COLOR: "session", EMPTY: "" }, { warn });
    expect(target).toEqual({ PATH: "/host/bin", COLOR: "session", HOST_ONLY: "yes", ENV_ONLY: "yes", EMPTY: "" });
    expect(warn.mock.calls).toEqual([["PATH"], ["PATH"]]);
  });

  it("does not expand the blocklist to loader, Node, proxy or similarly named keys", () => {
    const overlay = {
      LD_PRELOAD: "library", NODE_OPTIONS: "--trace-warnings", HTTP_PROXY: "http://proxy",
      HTTPS_PROXY: "http://proxy", ALL_PROXY: "http://proxy", NO_PROXY: "localhost",
      PATH_EXTRA: "allowed", HOMEPATH: "allowed", OMA: "allowed", X_OMA_KEY: "allowed",
    };
    const warn = vi.fn();
    expect(applyOverlayEnv({}, overlay, { warn })).toEqual(overlay);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns to daemon stderr with key names only, escaping control characters", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    applyOverlayEnv({}, { HOME: "secret-home", "oMa_\nKEY": "secret-token", NORMAL: "secret-value" });
    expect(stderr.mock.calls).toEqual([
      ['  ! custom_env: blocked key skipped key="HOME"\n'],
      ['  ! custom_env: blocked key skipped key="oMa_\\nKEY"\n'],
    ]);
  });
});
