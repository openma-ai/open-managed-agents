import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { EnvironmentWorkView } from "../src/index";
import {
  environmentWorkView,
  makeEnvironmentWorkPort,
} from "./environment-work-fixtures";
import { buildEnvironmentWorkTestApi } from "./test-api";

// The official contract (BetaSelfHostedWork.secret): "May be populated when
// polling for work; null on all other retrieval paths." The HTTP boundary must
// enforce that even if an application port hands it a populated credential.
const leakyWork: EnvironmentWorkView = {
  ...environmentWorkView,
  secret: {
    sessionsToken: "sk-ant-req-must-not-leak",
    apiBaseUrl: "https://openma.test",
    claimGeneration: 3,
  },
};

function clientFor(api: ReturnType<typeof buildEnvironmentWorkTestApi>) {
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

describe("Managed Agents API — Work secret is delivered only by poll", () => {
  const port = makeEnvironmentWorkPort({
    pollEnvironmentWork: async () => ({ type: "work", work: leakyWork }),
    retrieveEnvironmentWork: async () => ({ type: "found", work: leakyWork }),
    updateEnvironmentWork: async () => ({ type: "updated", work: leakyWork }),
    listEnvironmentWork: async () => ({
      type: "page",
      page: { workItems: [leakyWork], nextCursor: null },
    }),
    acknowledgeEnvironmentWork: async () => ({
      type: "acknowledged",
      work: leakyWork,
    }),
    stopEnvironmentWork: async () => ({ type: "stopped", work: leakyWork }),
  });
  const client = clientFor(buildEnvironmentWorkTestApi(port));
  const scope = { environment_id: "env_self_01" };

  it("stop (force) never returns the Work secret", async () => {
    const work = await client.beta.environments.work.stop("work_01", {
      ...scope,
      force: true,
    });
    expect(work.secret).toBeNull();
    expect(JSON.stringify(work)).not.toContain("sk-ant-req-must-not-leak");
  });

  it("retrieve, update, list and ack never return the Work secret", async () => {
    const responses = [
      await client.beta.environments.work.retrieve("work_01", scope),
      await client.beta.environments.work.update("work_01", {
        ...scope,
        metadata: { shard: "b" },
      }),
      (await client.beta.environments.work.list("env_self_01")).data[0]!,
      await client.beta.environments.work.ack("work_01", scope),
    ];
    for (const work of responses) {
      expect(work.secret).toBeNull();
      expect(JSON.stringify(work)).not.toContain("sk-ant-req-must-not-leak");
    }
  });

  it("poll still delivers the encoded Work secret to the claiming worker", async () => {
    const work = await client.beta.environments.work.poll("env_self_01", {
      "Anthropic-Worker-ID": "worker_01",
    });
    expect(work?.secret).toEqual(expect.any(String));
    expect(
      JSON.parse(Buffer.from(work!.secret!, "base64url").toString("utf8")),
    ).toEqual({
      sessions_token: "sk-ant-req-must-not-leak",
      api_base_url: "https://openma.test",
      claim_generation: 3,
    });
  });
});
