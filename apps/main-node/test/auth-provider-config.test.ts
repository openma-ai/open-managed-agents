import { describe, expect, it } from "vitest";

import {
  buildSocialProviders,
  listAuthProviders,
} from "@open-managed-agents/shared";

describe("auth provider configuration", () => {
  it("wires complete Google and GitHub credentials into Better Auth", () => {
    expect(
      buildSocialProviders({
        googleClientId: "google-id",
        googleClientSecret: "google-secret",
        githubClientId: "github-id",
        githubClientSecret: "github-secret",
      }),
    ).toEqual({
      google: { clientId: "google-id", clientSecret: "google-secret" },
      github: { clientId: "github-id", clientSecret: "github-secret" },
    });
  });

  it("advertises only providers with complete credential pairs", () => {
    expect(
      listAuthProviders({
        emailOtp: true,
        googleClientId: "google-id",
        githubClientId: "github-id",
        githubClientSecret: "github-secret",
      }),
    ).toEqual(["email", "email-otp", "github"]);
  });
});
