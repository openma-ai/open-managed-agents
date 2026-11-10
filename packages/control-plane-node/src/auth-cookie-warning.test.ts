import { describe, expect, it } from "vitest";
import {
  authCookieWarning,
  MISSING_PUBLIC_BASE_URL_WARNING,
} from "./auth-cookie-warning.js";

describe("authCookieWarning", () => {
  it("warns when PUBLIC_BASE_URL is missing", () => {
    expect(authCookieWarning({ authDisabled: false, publicBaseUrl: undefined }))
      .toBe(MISSING_PUBLIC_BASE_URL_WARNING);
  });

  it("warns on an empty or blank PUBLIC_BASE_URL", () => {
    // Compose renders `PUBLIC_BASE_URL=` as an empty string, not as unset.
    expect(authCookieWarning({ authDisabled: false, publicBaseUrl: "" }))
      .toBe(MISSING_PUBLIC_BASE_URL_WARNING);
    expect(authCookieWarning({ authDisabled: false, publicBaseUrl: "   " }))
      .toBe(MISSING_PUBLIC_BASE_URL_WARNING);
  });

  it("stays quiet for an http origin, which is the fix itself", () => {
    expect(authCookieWarning({ authDisabled: false, publicBaseUrl: "http://host:8787" })).toBeNull();
  });

  it("stays quiet for an https origin", () => {
    expect(authCookieWarning({ authDisabled: false, publicBaseUrl: "https://oma.example.com" })).toBeNull();
  });

  it("stays quiet when auth is disabled", () => {
    expect(authCookieWarning({ authDisabled: true, publicBaseUrl: undefined })).toBeNull();
  });
});
