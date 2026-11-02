import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiError } from "../lib/api";
import { isSessionNotFoundError, SessionNotFound } from "./SessionDetail";

describe("session not-found state", () => {
  it("treats only 404 / not_found_error as not found", () => {
    expect(isSessionNotFoundError(new ApiError({ status: 404, code: "not_found_error", message: "x" }))).toBe(true);
    expect(isSessionNotFoundError(new ApiError({ status: 404, code: "", message: "x" }))).toBe(true);
    expect(isSessionNotFoundError(new ApiError({ status: 500, code: "api_error", message: "x" }))).toBe(false);
    expect(isSessionNotFoundError(new ApiError({ status: 403, code: "permission_error", message: "x" }))).toBe(false);
    expect(isSessionNotFoundError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("renders a 404 view with the id, a link back, and no composer", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><SessionNotFound id="sesn_bad" /></MemoryRouter>,
    );
    expect(html).toContain("Session not found");
    expect(html).toContain("sesn_bad");
    expect(html).toContain('href="/sessions"');
    expect(html).not.toContain("Send a message");
    expect(html).not.toContain("<textarea");
  });
});
