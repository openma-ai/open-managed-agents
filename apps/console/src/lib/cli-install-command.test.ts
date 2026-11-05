import { describe, expect, it } from "vitest";
import { cliInstallCommand } from "./cli-install-command";

describe("cliInstallCommand", () => {
  it.each([
    "https://app.openma.ai",
    "https://app.openma.dev",
    "https://openma.ai",
    "https://openma.dev",
    "https://app.openma.ai/",
    "",
    "null",
  ])("uses CLI defaults for hosted or unavailable origin %s", (origin) => {
    expect(cliInstallCommand(origin)).toEqual({
      command: "npx -y -p @openma/cli oma",
      globalCommand: "npm i -g @openma/cli",
    });
  });

  it.each([
    "https://oma.example.com",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "https://oma.example.com:8443",
    "https://app.openma.ai:8443",
    "https://app.openma.ai.example.com",
    "http://app.openma.ai",
  ])("targets the current deployment at %s", (origin) => {
    expect(cliInstallCommand(origin)).toEqual({
      command: `npx -y -p @openma/cli oma --base-url ${origin}`,
      globalCommand: "npm i -g @openma/cli",
      envHint: `export OMA_BASE_URL=${origin}`,
    });
  });

  it("omits a trailing slash from a custom origin", () => {
    expect(cliInstallCommand("https://oma.example.com/")).toEqual(
      cliInstallCommand("https://oma.example.com"),
    );
  });
});
