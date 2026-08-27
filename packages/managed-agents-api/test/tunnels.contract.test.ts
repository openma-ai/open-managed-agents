import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { TunnelsApplicationPort } from "../src/index";
import { makeTunnelsPort, tunnelView } from "./tunnel-fixtures";
import { buildTunnelsTestApi } from "./test-api";

function makeClient(port: TunnelsApplicationPort): Anthropic {
  const api = buildTunnelsTestApi({ tunnels: port });
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

describe("MCP Tunnels API — tunnels", () => {
  it("creates a tunnel", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelsPort({
        createTunnel: async (command) => {
          calls.push(command);
          return { type: "created", tunnel: tunnelView };
        },
      }),
    );

    const tunnel = await client.beta.tunnels.create({
      display_name: "Production gateway",
    });

    expect(calls).toEqual([{ displayName: "Production gateway" }]);
    expect(tunnel).toEqual({
      id: "tnl_01",
      archived_at: null,
      created_at: "2026-08-26T17:00:00.000Z",
      display_name: "Production gateway",
      domain: "tnl-01.tunnels.anthropic.test",
      type: "tunnel",
    });
  });

  it("retrieves a tunnel", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelsPort({
        retrieveTunnel: async (query) => {
          calls.push(query);
          return { type: "found", tunnel: tunnelView };
        },
      }),
    );

    await client.beta.tunnels.retrieve("tnl_01");

    expect(calls).toEqual([{ tunnelId: "tnl_01" }]);
  });

  it("lists tunnels with semantic pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelsPort({
        listTunnels: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { tunnels: [tunnelView], nextCursor: "tunnel_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.tunnels.list({
      limit: 10,
      page: "tunnel_page_01",
      include_archived: true,
    });

    expect(calls).toEqual([
      { pageSize: 10, cursor: "tunnel_page_01", includeArchived: true },
    ]);
    expect(page.next_page).toBe("tunnel_page_02");
  });

  it("archives a tunnel", async () => {
    const calls: unknown[] = [];
    const archived = {
      ...tunnelView,
      archivedAt: "2026-08-26T18:00:00.000Z",
    };
    const client = makeClient(
      makeTunnelsPort({
        archiveTunnel: async (command) => {
          calls.push(command);
          return { type: "archived", tunnel: archived };
        },
      }),
    );

    const tunnel = await client.beta.tunnels.archive("tnl_01");

    expect(calls).toEqual([{ tunnelId: "tnl_01" }]);
    expect(tunnel.archived_at).toBe("2026-08-26T18:00:00.000Z");
  });

  it("reveals a tunnel token without exposing it on the tunnel view", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelsPort({
        revealTunnelToken: async (command) => {
          calls.push(command);
          return {
            type: "revealed",
            token: { id: "ttok_01", token: "secret-token" },
          };
        },
      }),
    );

    const token = await client.beta.tunnels.revealToken("tnl_01");

    expect(calls).toEqual([{ tunnelId: "tnl_01" }]);
    expect(token).toEqual({
      id: "ttok_01",
      tunnel_token: "secret-token",
      type: "tunnel_token",
    });
  });

  it("rotates a token with an audit reason", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeTunnelsPort({
        rotateTunnelToken: async (command) => {
          calls.push(command);
          return {
            type: "rotated",
            token: { id: "ttok_02", token: "new-secret-token" },
          };
        },
      }),
    );

    await client.beta.tunnels.rotateToken("tnl_01", {
      reason: "Scheduled rotation",
    });

    expect(calls).toEqual([
      { tunnelId: "tnl_01", reason: "Scheduled rotation" },
    ]);
  });
});
