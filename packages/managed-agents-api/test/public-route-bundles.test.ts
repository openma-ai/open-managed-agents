import { describe, expect, it } from "vitest";
import * as managedAgentsApi from "../src";

describe("Managed Agents API public route bundles", () => {
  it("exports every official resource bundle for per-port composition", () => {
    expect(managedAgentsApi).toMatchObject({
      buildDeploymentRunRoutes: expect.any(Function),
      buildDeploymentRoutes: expect.any(Function),
      buildDreamRoutes: expect.any(Function),
      buildEnvironmentWorkRoutes: expect.any(Function),
      buildSkillRoutes: expect.any(Function),
      buildSkillVersionRoutes: expect.any(Function),
      buildTunnelRoutes: expect.any(Function),
      buildTunnelCertificateRoutes: expect.any(Function),
    });
  });
});
