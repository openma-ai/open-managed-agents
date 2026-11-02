import { describe, expect, it } from "vitest";
import { MANAGED_AGENTS_BETA } from "../src/beta";
import { makeSessionsPort } from "./session-fixtures";
import { buildSessionsTestApi } from "./test-api";

const beta = { "anthropic-beta": MANAGED_AGENTS_BETA };

describe("Managed Agents API — session list metadata query params removed", () => {
  it("rejects metadata_key and metadata_value on GET /v1/sessions", async () => {
    const port = makeSessionsPort({
      listSessions: async () => {
        throw new Error("list should not run");
      },
    });
    const api = buildSessionsTestApi(port);

    const paired = await api.fetch(new Request(
      "http://openma.test/v1/sessions?metadata_key=project_id&metadata_value=proj_a",
      { headers: beta },
    ));
    const keyOnly = await api.fetch(new Request(
      "http://openma.test/v1/sessions?metadata_key=project_id",
      { headers: beta },
    ));
    const valueOnly = await api.fetch(new Request(
      "http://openma.test/v1/sessions?metadata_value=proj_a",
      { headers: beta },
    ));

    expect(paired.status).toBe(400);
    expect(keyOnly.status).toBe(400);
    expect(valueOnly.status).toBe(400);
    await expect(paired.json()).resolves.toMatchObject({
      error: {
        message: expect.stringContaining("metadata_key and metadata_value"),
      },
    });
  });
});
