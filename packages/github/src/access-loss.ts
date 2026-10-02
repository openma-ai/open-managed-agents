/**
 * GitHub's mapping for a missing installation or repository. A bare HTTP
 * 404 is not enough — the body has to name the installation or repository.
 */
export const githubAccessLossCatalog = {
  provider: "github",
  serverNames: ["github"],
  scopeLost: [
    { code: "installation_not_found", resourceType: "installation" },
    { code: "repository_not_found", resourceType: "repository" },
  ],
  credentialLost: [] as readonly string[],
  phrases: [
    {
      phrase: "integration installation was not found",
      code: "installation_not_found",
      resourceType: "installation",
    },
    {
      phrase: "resource not accessible by integration",
      code: "installation_not_found",
      resourceType: "installation",
    },
    { phrase: "repository not found", code: "repository_not_found", resourceType: "repository" },
  ],
  table: "github_issue_sessions",
  terminalStatus: "inactive",
  clearPendingScan: false,
} as const;
