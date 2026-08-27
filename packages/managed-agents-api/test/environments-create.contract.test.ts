import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { buildEnvironmentsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/environments", () => {
  it("maps the latest cloud config into an application-native command", async () => {
    const createCalls: unknown[] = [];
    const port = makeEnvironmentsPort({
      createEnvironment: async (command) => {
        createCalls.push(command);
        return {
          type: "created",
          environment: {
            id: "env_01",
            archivedAt: null,
            config: {
              type: "cloud",
              networking: {
                type: "limited",
                allowMcpServers: true,
                allowPackageManagers: false,
                allowedHosts: ["api.example.com"],
              },
              packages: {
                apt: ["git"],
                cargo: [],
                gem: [],
                go: [],
                npm: ["tsx"],
                pip: ["numpy==2.0.0"],
              },
            },
            createdAt: "2026-08-26T08:00:00.000Z",
            description: "Cloud runner",
            metadata: { team: "platform" },
            name: "cloud-runner",
            updatedAt: "2026-08-26T08:00:00.000Z",
            scope: "organization",
          },
        };
      },
    });
    const api = buildEnvironmentsTestApi(port);
    const client = new Anthropic({
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

    const environment = await client.beta.environments.create({
      name: "cloud-runner",
      description: "Cloud runner",
      metadata: { team: "platform" },
      scope: "organization",
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allow_mcp_servers: true,
          allow_package_managers: false,
          allowed_hosts: ["api.example.com"],
        },
        packages: {
          type: "packages",
          apt: ["git"],
          npm: ["tsx"],
          pip: ["numpy==2.0.0"],
        },
      },
    });

    expect(createCalls).toEqual([
      {
        name: "cloud-runner",
        description: "Cloud runner",
        metadata: { team: "platform" },
        scope: "organization",
        config: {
          type: "cloud",
          networking: {
            type: "limited",
            allowMcpServers: true,
            allowPackageManagers: false,
            allowedHosts: ["api.example.com"],
          },
          packages: {
            apt: ["git"],
            npm: ["tsx"],
            pip: ["numpy==2.0.0"],
          },
        },
      },
    ]);
    expect(environment).toMatchObject({
      id: "env_01",
      type: "environment",
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allow_mcp_servers: true,
          allow_package_managers: false,
          allowed_hosts: ["api.example.com"],
        },
        packages: {
          type: "packages",
          apt: ["git"],
          cargo: [],
          gem: [],
          go: [],
          npm: ["tsx"],
          pip: ["numpy==2.0.0"],
        },
      },
      scope: "organization",
    });
  });
});
