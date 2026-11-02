import { describe, expect, it } from "vitest";
import { installEnvironmentPackages } from "../../../packages/control-plane-node/src/lib/environment-packages.js";

/** A sandbox that records commands and env vars, with configurable setup output. */
function sandbox(setupOutput = "") {
  const commands: string[] = [];
  const env: Record<string, string> = {};
  const markers = new Map<string, string>();
  return {
    commands,
    env,
    exec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("WARM=")) return `WARM=${markers.get("w") ?? "MISSING"}\nREST=${markers.get("r") ?? "MISSING"}`;
      if (command.startsWith("(\nset -e")) return setupOutput;
      if (command.startsWith("printf")) return "/usr/local/bin:/usr/bin:/bin";
      const w = command.match(/echo "(\w+)" > \/tmp\/\.oma-setup-warm/);
      if (w) markers.set("w", w[1]!);
      return "";
    },
    setEnvVars: async (vars: Record<string, string>) => {
      Object.assign(env, vars);
    },
  };
}

const environment = (packages: Record<string, string[]>, type = "cloud") => ({
  id: "env_report",
  config: { type, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [], ...packages } },
});

describe("Environment packages on the Node runtime", () => {
  it("installs pip packages, uses the configured index and puts the venv on PATH", async () => {
    const box = sandbox();
    const logged: string[] = [];
    await installEnvironmentPackages(box, environment({ pip: ["pyodps"] }), {
      pipIndexUrl: "https://mirror.example/simple/",
      log: (result) => logged.push(result.path),
    });
    const setup = box.commands.find((c) => c.startsWith("(\nset -e"));
    expect(setup).toContain("'pyodps'");
    expect(setup).toContain("UV_INDEX_URL='https://mirror.example/simple/'");
    expect(logged).toEqual(["fresh"]);
    expect(box.env.PATH).toBe(
      "/workspace/.venv/bin:/workspace/.npm-global/bin:/workspace/.cargo/bin:/workspace/.go/bin:/usr/local/bin:/usr/bin:/bin",
    );
  });

  it("scopes the setup markers to the Environment's catalog image", async () => {
    const box = sandbox();
    await installEnvironmentPackages(box, { ...environment({ pip: ["pyodps"] }), openma: { sandboxImage: "analytics" } });
    const markers = box.commands.find((c) => c.includes("> /workspace/.oma-setup-restored"));
    expect(markers).toMatch(/echo "[0-9a-f]{8}:analytics" > \/workspace\/\.oma-setup-restored/);
    expect(box.commands.find((c) => c.startsWith("(\nset -e"))).toContain("rm -rf /workspace/.venv");
  });

  it("does nothing for an Environment without packages or a self-hosted one", async () => {
    const empty = sandbox();
    await installEnvironmentPackages(empty, environment({}));
    const selfHosted = sandbox();
    await installEnvironmentPackages(selfHosted, environment({ pip: ["pyodps"] }, "self_hosted"));
    expect(empty.commands).toEqual([]);
    expect(selfHosted.commands).toEqual([]);
  });

  it("fails the session with the install output when setup fails", async () => {
    const box = sandbox("ERROR: No matching distribution found for pyodps\n[exit 1]");
    await expect(installEnvironmentPackages(box, environment({ pip: ["pyodps"] }))).rejects.toThrow(
      /Environment env_report setup failed at fresh: full_setup_failed exit=1: .*No matching distribution/,
    );
    expect(box.env.PATH).toBeUndefined();
  });
});
