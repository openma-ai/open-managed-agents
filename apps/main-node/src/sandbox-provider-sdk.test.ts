import { describe, expect, it } from "vitest";
import {
  assertSandboxProviderSdk,
  SANDBOX_PROVIDER_SDK_PACKAGES,
} from "./sandbox-provider-sdk.js";

describe("assertSandboxProviderSdk", () => {
  it("probes the SDK the selected provider needs", async () => {
    const loaded: string[] = [];
    await assertSandboxProviderSdk({ provider: "e2b" }, async (specifier) => {
      loaded.push(specifier);
    });
    expect(loaded).toEqual(["e2b"]);
  });

  it("maps every isolated provider to its vendor package", () => {
    expect(SANDBOX_PROVIDER_SDK_PACKAGES).toMatchObject({
      e2b: "e2b",
      daytona: "@daytonaio/sdk",
      litebox: "@boxlite-ai/boxlite",
      boxlite: "@boxlite-ai/boxlite",
      opensandbox: "@alibaba-group/opensandbox",
      sprites: "@fly/sprites",
    });
  });

  it("does not probe boxrun, which talks to boxlite over HTTP", async () => {
    const loaded: string[] = [];
    await assertSandboxProviderSdk({ provider: "boxrun" }, async (specifier) => {
      loaded.push(specifier);
    });
    expect(loaded).toEqual([]);
  });

  it("does not probe the local test adapter", async () => {
    const loaded: string[] = [];
    await assertSandboxProviderSdk({ provider: "test-local-subprocess" }, async (specifier) => {
      loaded.push(specifier);
    });
    expect(loaded).toEqual([]);
  });

  it("fails at startup with both install paths when the SDK is missing", async () => {
    await expect(
      assertSandboxProviderSdk({ provider: "e2b" }, async () => {
        throw new Error("Cannot find package 'e2b'");
      }),
    ).rejects.toThrow(/requires the "e2b" SDK.*pnpm add -w e2b.*SANDBOX_PROVIDERS=e2b/s);
  });
});
