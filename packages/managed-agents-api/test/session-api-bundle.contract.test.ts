import Anthropic from "@anthropic-ai/sdk";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { buildManagedSessionsApi } from "../src/index";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import {
  makeSessionThreadEventsPort,
  makeSessionThreadsPort,
} from "./session-thread-fixtures";
import { makeSessionsPort } from "./session-fixtures";

describe("Managed Agents API — Sessions route bundle", () => {
  it("mounts the complete official Sessions surface from only request-scoped application Ports", async () => {
    const resolutions: string[] = [];
    const api = new Hono<{ Variables: { workspaceId: string } }>();
    api.use("/v1/*", async (c, next) => {
      c.set("workspaceId", c.req.header("x-test-workspace") ?? "missing");
      await next();
    });
    const workspace = (context: Context) =>
      (context.var as { workspaceId: string }).workspaceId;

    api.route(
      "/v1/sessions",
      buildManagedSessionsApi({
        sessions: (c) => {
          resolutions.push(`sessions:${workspace(c)}`);
          return makeSessionsPort({
            listSessions: async () => ({
              type: "page",
              page: {
                sessions: [],
                nextCursor: null,
                previousCursor: null,
              },
            }),
          });
        },
        sessionEvents: (c) => {
          resolutions.push(`events:${workspace(c)}`);
          return makeSessionEventsPort({
            listSessionEvents: async () => ({
              type: "page",
              page: { events: [], nextCursor: null },
            }),
          });
        },
        sessionResources: (c) => {
          resolutions.push(`resources:${workspace(c)}`);
          return makeSessionResourcesPort({
            listSessionResources: async () => ({
              type: "page",
              page: { resources: [], nextCursor: null },
            }),
          });
        },
        sessionThreads: (c) => {
          resolutions.push(`threads:${workspace(c)}`);
          return makeSessionThreadsPort({
            listSessionThreads: async () => ({
              type: "page",
              page: { threads: [], nextCursor: null },
            }),
          });
        },
        sessionThreadEvents: (c) => {
          resolutions.push(`thread-events:${workspace(c)}`);
          return makeSessionThreadEventsPort({
            listSessionThreadEvents: async () => ({
              type: "page",
              page: { events: [], nextCursor: null },
            }),
          });
        },
      }),
    );

    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        request.headers.set("x-test-workspace", "workspace_bundle");
        return api.fetch(request);
      },
    });

    await client.beta.sessions.list();
    await client.beta.sessions.events.list("session_01");
    await client.beta.sessions.resources.list("session_01");
    await client.beta.sessions.threads.list("session_01");
    await client.beta.sessions.threads.events.list("thread_01", {
      session_id: "session_01",
    });

    expect(resolutions).toEqual([
      "sessions:workspace_bundle",
      "events:workspace_bundle",
      "resources:workspace_bundle",
      "threads:workspace_bundle",
      "thread-events:workspace_bundle",
    ]);
  });
});
