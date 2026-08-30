import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    kill: vi.fn(),
  })),
}));

vi.mock("e2b", () => ({
  Sandbox: { create: sdk.create },
}));

import { sandboxFactory } from "../src/adapters/e2b";

describe("E2B SDK v2 adapter", () => {
  beforeEach(() => sdk.create.mockClear());

  it("passes the template and self-hosted endpoints using the official v2 shape", async () => {
    await sandboxFactory(
      { sessionId: "session_e2b", workdir: "/tmp/unused" },
      {
        E2B_API_KEY: "local",
        E2B_API_URL: "http://127.0.0.1:3000",
        E2B_SANDBOX_URL: "http://127.0.0.1:3002",
        E2B_DOMAIN: "localhost",
        SANDBOX_IMAGE: "code-interpreter",
      },
    );

    expect(sdk.create).toHaveBeenCalledWith("code-interpreter", {
      apiKey: "local",
      apiUrl: "http://127.0.0.1:3000",
      sandboxUrl: "http://127.0.0.1:3002",
      domain: "localhost",
    });
  });
});
