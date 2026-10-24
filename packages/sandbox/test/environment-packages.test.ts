import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildFullSetupScript,
  ensureEnvironmentPackages,
  hasEnvironmentPackages,
  parseExecResult,
  type PackageSandbox,
} from "../src/environment-packages";

/** A sandbox that remembers the markers it was asked to write. */
function fakeSandbox(failSetup = false) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const sandbox: PackageSandbox = {
    async exec(command) {
      commands.push(command);
      if (command.startsWith("WARM=")) {
        return `WARM=${files.get("warm") ?? "MISSING"}\nREST=${files.get("rest") ?? "MISSING"}`;
      }
      if (command.startsWith("(\nset -e")) return failSetup ? "No module named uv\n[exit 1]" : "";
      const warm = command.match(/echo "([^"]+)" > \/tmp\/\.oma-setup-warm/);
      const rest = command.match(/echo "([^"]+)" > \/workspace\/\.oma-setup-restored/);
      if (warm) files.set("warm", warm[1]!);
      if (rest) files.set("rest", rest[1]!);
      return "";
    },
  };
  return { sandbox, commands, files };
}

describe("environment packages", () => {
  it("reads both exec result shapes", () => {
    expect(parseExecResult("exit=2\nout\nstderr: boom")).toEqual({ exitCode: 2, stdout: "out", stderr: "boom" });
    expect(parseExecResult("some output\n[exit 1]")).toEqual({ exitCode: 1, stdout: "some output", stderr: "" });
    expect(parseExecResult("[exit 127]").exitCode).toBe(127);
    expect(parseExecResult("all good").exitCode).toBe(0);
  });

  it("knows when there is nothing to install", () => {
    expect(hasEnvironmentPackages(undefined)).toBe(false);
    expect(hasEnvironmentPackages({ pip: [], npm: [], gem: ["rails"] })).toBe(false);
    expect(hasEnvironmentPackages({ pip: ["pyodps"] })).toBe(true);
    expect(buildFullSetupScript({ pip: [] })).toBe("");
  });

  it("installs pip packages into /workspace/.venv, with uv from pip when the image lacks it", () => {
    const script = buildFullSetupScript({ pip: ["pyodps", "pandas>=2"] }, { pipIndexUrl: "https://mirror.example/simple/" });
    expect(script.startsWith("(\nset -e\n")).toBe(true);
    expect(script.endsWith("\n)")).toBe(true);
    expect(script).toContain("export UV_INDEX_URL='https://mirror.example/simple/' PIP_INDEX_URL='https://mirror.example/simple/'");
    expect(script).toContain("command -v uv");
    expect(script).toContain("$UV pip install --python /workspace/.venv/bin/python -q 'pyodps' 'pandas>=2'");
    expect(script).toContain("export PATH=/workspace/.venv/bin:");
  });

  it("creates the venv with system site packages so image-baked packages stay importable", () => {
    const script = buildFullSetupScript({ pip: ["pyodps"] });
    expect(script).toContain("[ -d /workspace/.venv ] || $UV venv -q --system-site-packages /workspace/.venv");
    // An existing (e.g. restored) venv is reused as-is, never recreated.
    expect(script).not.toMatch(/\$UV venv(?! -q --system-site-packages)/);
  });

  it("keeps the warm/restored markers stable across the venv flag change", async () => {
    // Values pinned from before the flag change: hashes cover only package
    // lists, so earlier containers/workspaces stay warm/restored (no reinstall).
    const { sandbox, files } = fakeSandbox();
    await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(files.get("warm")).toBe("a0bbafd0");
    expect(files.get("rest")).toBe("5cb03e2c");
  });

  describe("on an operator catalog image", () => {
    const setups = (commands: string[]) => commands.filter((c) => c.startsWith("(\nset -e"));

    it("leaves markers and the script unchanged when no image is selected", async () => {
      const { sandbox, files, commands } = fakeSandbox();
      await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, {});
      expect(files.get("warm")).toBe("a0bbafd0");
      expect(files.get("rest")).toBe("5cb03e2c");
      expect(setups(commands)[0]).not.toContain("rm -rf /workspace/.venv");
    });

    it("scopes markers to the alias and stays restored on the same image", async () => {
      const { sandbox, files, commands } = fakeSandbox();
      const first = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, { sandboxImage: "analytics" });
      expect(first.path).toBe("fresh");
      expect(files.get("warm")).toBe("a0bbafd0:analytics");
      expect(files.get("rest")).toBe("5cb03e2c:analytics");

      files.delete("warm"); // cold restart, /workspace restored
      const restored = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, { sandboxImage: "analytics" });
      expect(restored.path).toBe("restored");
      expect(setups(commands)).toHaveLength(1);
    });

    it("removes and rebuilds the venv when the workspace was set up on another image", async () => {
      for (const previous of [undefined, "analytics"]) {
        const { sandbox, files, commands } = fakeSandbox();
        await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, previous ? { sandboxImage: previous } : {});
        files.delete("warm"); // restored onto the new image
        const switched = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, { sandboxImage: "web" });
        expect(switched.path).toBe("fresh");
        const script = setups(commands)[1]!;
        expect(script.indexOf("rm -rf /workspace/.venv")).toBeGreaterThan(-1);
        expect(script.indexOf("rm -rf /workspace/.venv")).toBeLessThan(script.indexOf("$UV venv"));
        expect(files.get("rest")).toBe("5cb03e2c:web");
      }
    });

    it("also drops a catalog image's venv when switching back to the default image", async () => {
      const { sandbox, files, commands } = fakeSandbox();
      await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, { sandboxImage: "analytics" });
      files.delete("warm"); // restored onto the default image
      const back = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, {});
      expect(back.path).toBe("fresh");
      const script = setups(commands)[1]!;
      expect(script.indexOf("rm -rf /workspace/.venv")).toBeGreaterThan(-1);
      expect(script.indexOf("rm -rf /workspace/.venv")).toBeLessThan(script.indexOf("$UV venv"));
      // Back on the plain default markers, so later restores stay byte-identical.
      expect(files.get("rest")).toBe("5cb03e2c");
      files.delete("warm");
      const again = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, {});
      expect(again.path).toBe("restored");
    });

    it("never drops the venv of a workspace that only ever used the default image", async () => {
      const { sandbox, files, commands } = fakeSandbox();
      await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, {});
      files.delete("warm");
      // A package change takes the fresh path but keeps the original script.
      await ensureEnvironmentPackages(sandbox, { pip: ["pyodps", "pandas"] }, undefined, {});
      expect(setups(commands)).toHaveLength(2);
      expect(setups(commands)[1]).toBe(buildFullSetupScript({ pip: ["pyodps", "pandas"] }));
      for (const script of setups(commands)) expect(script).not.toContain("rm -rf /workspace/.venv");
    });

    it("drops a catalog image's venv on switch-back even when no pip packages remain", async () => {
      for (const next of [{ npm: ["typescript"] }, {}]) {
        const { sandbox, files, commands } = fakeSandbox();
        await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] }, undefined, { sandboxImage: "analytics" });
        files.delete("warm");
        const back = await ensureEnvironmentPackages(sandbox, next, undefined, {});
        expect(back.path).toBe("fresh");
        expect(setups(commands)[1]).toContain("rm -rf /workspace/.venv");
      }
      // Default-only workspaces without packages still run no setup at all.
      const { sandbox, commands } = fakeSandbox();
      await ensureEnvironmentPackages(sandbox, {}, undefined, {});
      expect(setups(commands)).toHaveLength(0);
    });

    it("rejects an alias that could not be a catalog alias", async () => {
      const { sandbox } = fakeSandbox();
      await expect(ensureEnvironmentPackages(sandbox, { pip: ["x"] }, undefined, { sandboxImage: "bad alias\"" }))
        .rejects.toThrow("Invalid sandbox image alias");
    });
  });

  it("writes scripts a shell can parse", () => {
    const script = buildFullSetupScript({
      apt: ["jq"],
      pip: ["it's"],
      npm: ["typescript"],
      cargo: ["ripgrep"],
      go: ["example.com/tool@latest"],
    });
    const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("installs once, then finds the container warm", async () => {
    const { sandbox, commands } = fakeSandbox();
    const first = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(first).toMatchObject({ path: "fresh" });
    expect(first.error).toBeUndefined();
    expect(commands.filter((c) => c.startsWith("(\nset -e"))).toHaveLength(1);

    const second = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(second.path).toBe("warm");
    expect(commands.filter((c) => c.startsWith("(\nset -e"))).toHaveLength(1);

    // A changed package list installs again.
    expect((await ensureEnvironmentPackages(sandbox, { pip: ["pyodps", "pandas"] })).path).toBe("fresh");
  });

  describe("warm requires both markers (prepared-base snapshots)", () => {
    const packages = { apt: ["jq"], pip: ["pyodps"] };
    async function installed() {
      const box = fakeSandbox();
      await ensureEnvironmentPackages(box.sandbox, packages);
      box.commands.length = 0;
      return box;
    }

    it("is warm only when /tmp and /workspace markers both match", async () => {
      const { sandbox, commands } = await installed();
      expect((await ensureEnvironmentPackages(sandbox, packages)).path).toBe("warm");
      expect(commands.filter((c) => !c.startsWith("WARM="))).toEqual([]);
    });

    it("runs the full setup when /tmp matches but /workspace lost its marker", async () => {
      // Snapshot carries the builder's /tmp marker; a checkpoint replaced /workspace.
      const { sandbox, commands, files } = await installed();
      files.delete("rest");
      expect((await ensureEnvironmentPackages(sandbox, packages)).path).toBe("fresh");
      expect(commands.filter((c) => c.startsWith("(\nset -e"))).toHaveLength(1);
    });

    it("reinstalls only apt when /tmp is stale but /workspace still matches the langs", async () => {
      const { sandbox, commands, files } = await installed();
      // /tmp records an older apt list (full differs), /workspace lang hash still matches.
      const before = fakeSandbox();
      await ensureEnvironmentPackages(before.sandbox, { apt: ["curl"], pip: ["pyodps"] });
      files.set("warm", before.files.get("warm")!);
      expect((await ensureEnvironmentPackages(sandbox, packages)).path).toBe("restored");
      expect(commands.some((c) => c.startsWith("apt-get update"))).toBe(true);
      expect(commands.some((c) => c.startsWith("(\nset -e"))).toBe(false);
    });
  });

  it("reports a failed install and leaves no marker, so the next start retries", async () => {
    const { sandbox, files } = fakeSandbox(true);
    const result = await ensureEnvironmentPackages(sandbox, { pip: ["pyodps"] });
    expect(result.path).toBe("fresh");
    expect(result.error).toMatch(/^full_setup_failed exit=1: .*No module named uv/);
    expect(files.size).toBe(0);
  });
});
