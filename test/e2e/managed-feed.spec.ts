import { expect, test, type Page } from "@playwright/test";

const createdAt = "2026-09-01T00:00:00.000Z";

function agent(id: string, name: string) {
  return {
    id,
    type: "agent",
    name,
    description: null,
    system: null,
    model: { id: "claude-sonnet-4-6", speed: "standard" },
    tools: [],
    skills: [],
    mcp_servers: [],
    multiagent: null,
    metadata: {},
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
  };
}

async function stubAuthenticatedConsole(page: Page) {
  await page.route("**/auth/get-session**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "session-browser-test",
          token: "browser-test-token",
          userId: "user-browser-test",
          createdAt,
          updatedAt: createdAt,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        user: {
          id: "user-browser-test",
          name: "Managed Feed Tester",
          email: "managed-feed@openma.test",
          emailVerified: true,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    }),
  );

  await page.route("**/v1/oma/me/tenants**", (route) =>
    route.fulfill({
      json: {
        data: [{ id: "tn_browser_test", name: "Browser Test", role: "owner" }],
      },
    }),
  );
  await page.route("**/v1/skills**", (route) =>
    route.fulfill({ json: { data: [], next_page: null } }),
  );
  await page.route("**/v1/oma/model_cards**", (route) =>
    route.fulfill({ json: { data: [], next_cursor: null } }),
  );
  await page.route("**/v1/oma/runtimes**", (route) =>
    route.fulfill({ json: { runtimes: [] } }),
  );
}

test("renders a feed while speaking the Managed page/next_page contract", async ({
  page,
}) => {
  await stubAuthenticatedConsole(page);

  const listRequests: URL[] = [];
  await page.route("**/v1/agents**", async (route) => {
    const url = new URL(route.request().url());
    listRequests.push(url);

    // Auxiliary picker hydration is deliberately not part of the visible feed.
    if (url.searchParams.get("limit") === "200") {
      await route.fulfill({ json: { data: [], next_page: null } });
      return;
    }

    const pageToken = url.searchParams.get("page");
    await route.fulfill({
      json: pageToken === "managed-next-page"
        ? { data: [agent("agent_second", "Second feed agent")], next_page: null }
        : {
            data: [agent("agent_first", "First feed agent")],
            next_page: "managed-next-page",
          },
    });
  });

  await page.goto("/agents");

  await expect(page.getByText("First feed agent", { exact: true })).toBeVisible();
  await expect(page.getByText("Second feed agent", { exact: true })).toBeVisible();

  const nextPageRequest = listRequests.find(
    (url) => url.searchParams.get("page") === "managed-next-page",
  );
  expect(nextPageRequest).toBeDefined();
  expect(nextPageRequest!.searchParams.has("cursor")).toBe(false);

  // Transport pages are flattened into one product feed: both records remain
  // visible and no page-number/previous-next navigation is introduced.
  await expect(page.getByText("First feed agent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /previous|next page/i })).toHaveCount(0);
});

test("opens the official Managed session event stream from the product conversation", async ({
  page,
}) => {
  await stubAuthenticatedConsole(page);

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/v1/sessions/session_browser/events/stream") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "event: ping\ndata: {}\n\n",
      });
      return;
    }
    if (path === "/v1/sessions/session_browser/events") {
      await route.fulfill({ json: { data: [], next_page: null } });
      return;
    }
    if (path === "/v1/sessions/session_browser/threads") {
      await route.fulfill({ json: { data: [], next_page: null } });
      return;
    }
    if (path === "/v1/sessions/session_browser") {
      await route.fulfill({
        json: {
          id: "session_browser",
          type: "session",
          title: "Managed stream browser test",
          status: "idle",
          agent: { id: "agent_browser", name: "Browser Agent", version: 1 },
          environment_id: null,
          vault_ids: [],
          created_at: createdAt,
          updated_at: createdAt,
          archived_at: null,
        },
      });
      return;
    }
    if (path === "/v1/oma/sessions/session_browser/pending") {
      await route.fulfill({ json: { data: [] } });
      return;
    }
    if (path === "/v1/oma/sessions/session_browser/trajectory") {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    if (path === "/v1/oma/sessions/session_browser") {
      await route.fulfill({ json: { metadata: {} } });
      return;
    }

    await route.fallback();
  });

  const streamRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/v1/sessions/session_browser/events/stream";
  });

  await page.goto("/sessions/session_browser");
  await expect(page.getByText("Managed stream browser test")).toBeVisible();

  const request = await streamRequest;
  const url = new URL(request.url());
  expect(url.searchParams.getAll("event_deltas[]")).toEqual([
    "agent.message",
    "agent.thinking",
  ]);
  expect(request.headers()["anthropic-beta"]).toContain(
    "managed-agents-2026-04-01",
  );
  expect(url.pathname).not.toContain("/v1/oma/");
});
