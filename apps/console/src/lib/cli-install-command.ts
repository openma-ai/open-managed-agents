// Keep in sync with the hosted URL family in packages/cli/src/bridge/lib/defaults.ts.
const hostedOrigins = new Set([
  "https://app.openma.ai",
  "https://app.openma.dev",
  "https://openma.ai",
  "https://openma.dev",
]);

export function cliInstallCommand(origin: string): {
  command: string;
  globalCommand: string;
  envHint?: string;
} {
  const baseUrl = origin.replace(/\/+$/, "");
  const customOrigin = baseUrl && baseUrl !== "null" && !hostedOrigins.has(baseUrl);

  return {
    command: `npx -y -p @openma/cli oma${customOrigin ? ` --base-url ${baseUrl}` : ""}`,
    globalCommand: "npm i -g @openma/cli",
    ...(customOrigin ? { envHint: `export OMA_BASE_URL=${baseUrl}` } : {}),
  };
}
