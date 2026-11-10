import { describe, expect, it } from "vitest";
import {
  assertSandboxProviderSdk,
  SANDBOX_PROVIDER_SDK_PACKAGES,
} from "./sandbox-provider-sdk.js";

const E2B = { provider: "e2b" as const, modulePath: "@open-managed-agents/sandbox-adapter-e2b" };

describe("assertSandboxProviderSdk", () => {
  it("resolves the SDK the selected provider needs, from the adapter's context", () => {
    const calls: [string, string][] = [];
    assertSandboxProviderSdk(
      { provider: "opensandbox", modulePath: "@open-managed-agents/sandbox-adapter-opensandbox" },
      (adapterModulePath, packageName) => {
        calls.push([adapterModulePath, packageName]);
        return "/somewhere/opensandbox/index.js";
      },
    );
    expect(calls).toEqual([["@open-managed-agents/sandbox-adapter-opensandbox", "@alibaba-group/opensandbox"]]);
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

  it("does not resolve anything for boxrun, which talks to boxlite over HTTP", () => {
    const calls: string[] = [];
    assertSandboxProviderSdk(
      { provider: "boxrun", modulePath: "@open-managed-agents/sandbox-adapter-boxrun" },
      (_adapterModulePath, packageName) => {
        calls.push(packageName);
        return "";
      },
    );
    expect(calls).toEqual([]);
  });

  it("does not resolve anything for the local test adapter", () => {
    const calls: string[] = [];
    assertSandboxProviderSdk(
      { provider: "test-local-subprocess", modulePath: "@open-managed-agents/sandbox/adapters/local-subprocess" },
      (_adapterModulePath, packageName) => {
        calls.push(packageName);
        return "";
      },
    );
    expect(calls).toEqual([]);
  });

  it("fails at startup with both install paths when the SDK cannot be resolved", () => {
    expect(() =>
      assertSandboxProviderSdk(E2B, () => {
        throw new Error("Cannot find module 'e2b'");
      }),
    ).toThrow(/requires the "e2b" SDK.*pnpm add -w e2b.*SANDBOX_PROVIDERS=e2b/s);
  });
});
