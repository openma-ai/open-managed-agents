import Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  makeDeploymentRunsPort,
  makeDeploymentsPort,
} from "./deployment-fixtures";
import { makeDreamsPort } from "./dream-fixtures";
import { makeEnvironmentWorkPort } from "./environment-work-fixtures";
import { makeSkillVersionsPort, makeSkillsPort } from "./skill-fixtures";
import {
  buildDeploymentsTestApi,
  buildDreamsTestApi,
  buildEnvironmentWorkTestApi,
  buildSkillsTestApi,
  buildTunnelsTestApi,
} from "./test-api";
import {
  makeTunnelCertificatesPort,
  makeTunnelsPort,
} from "./tunnel-fixtures";

function makeClient(api: Hono): Anthropic {
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

async function expectInvalidCursor(
  request: Promise<unknown>,
  message: string,
): Promise<void> {
  await expect(request).rejects.toMatchObject({
    status: 400,
    type: "invalid_request_error",
    error: {
      error: {
        type: "invalid_request_error",
        message,
      },
    },
  });
}

describe("Managed Agents API semantic cursor errors", () => {
  it("maps deployment and run cursor rejection to 400", async () => {
    const client = makeClient(
      buildDeploymentsTestApi({
        deployments: makeDeploymentsPort({
          listDeployments: async () => ({
            type: "invalid_request",
            message: "Invalid deployment page cursor",
          }),
        }),
        deploymentRuns: makeDeploymentRunsPort({
          listDeploymentRuns: async () => ({
            type: "invalid_request",
            message: "Invalid deployment run page cursor",
          }),
        }),
      }),
    );

    await expectInvalidCursor(
      client.beta.deployments.list({ page: "malformed" }),
      "Invalid deployment page cursor",
    );
    await expectInvalidCursor(
      client.beta.deploymentRuns.list({ page: "malformed" }),
      "Invalid deployment run page cursor",
    );
  });

  it("maps dream cursor rejection to 400", async () => {
    const client = makeClient(
      buildDreamsTestApi(
        makeDreamsPort({
          listDreams: async () => ({
            type: "invalid_request",
            message: "Invalid dream page cursor",
          }),
        }),
      ),
    );

    await expectInvalidCursor(
      client.beta.dreams.list({ page: "malformed" }),
      "Invalid dream page cursor",
    );
  });

  it("maps environment work cursor rejection to 400", async () => {
    const client = makeClient(
      buildEnvironmentWorkTestApi(
        makeEnvironmentWorkPort({
          listEnvironmentWork: async () => ({
            type: "invalid_request",
            message: "Invalid environment work page cursor",
          }),
        }),
      ),
    );

    await expectInvalidCursor(
      client.beta.environments.work.list("env_01", { page: "malformed" }),
      "Invalid environment work page cursor",
    );
  });

  it("maps skill and version cursor rejection to 400", async () => {
    const client = makeClient(
      buildSkillsTestApi(
        makeSkillsPort({
          listSkills: async () => ({
            type: "invalid_request",
            message: "Invalid skill page cursor",
          }),
        }),
        makeSkillVersionsPort({
          listSkillVersions: async () => ({
            type: "invalid_request",
            message: "Invalid skill version page cursor",
          }),
        }),
      ),
    );

    await expectInvalidCursor(
      client.beta.skills.list({ page: "malformed" }),
      "Invalid skill page cursor",
    );
    await expectInvalidCursor(
      client.beta.skills.versions.list("skill_01", { page: "malformed" }),
      "Invalid skill version page cursor",
    );
  });

  it("maps tunnel and certificate cursor rejection to 400", async () => {
    const client = makeClient(
      buildTunnelsTestApi({
        tunnels: makeTunnelsPort({
          listTunnels: async () => ({
            type: "invalid_request",
            message: "Invalid tunnel page cursor",
          }),
        }),
        tunnelCertificates: makeTunnelCertificatesPort({
          listTunnelCertificates: async () => ({
            type: "invalid_request",
            message: "Invalid tunnel certificate page cursor",
          }),
        }),
      }),
    );

    await expectInvalidCursor(
      client.beta.tunnels.list({ page: "malformed" }),
      "Invalid tunnel page cursor",
    );
    await expectInvalidCursor(
      client.beta.tunnels.certificates.list("tnl_01", { page: "malformed" }),
      "Invalid tunnel certificate page cursor",
    );
  });
});
