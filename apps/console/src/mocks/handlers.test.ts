import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./server";

// Smoke test for the MSW + setupFiles wiring. If this passes, the
// node server intercept is live and `onUnhandledRequest: 'error'`
// won't false-alarm on handlers added via server.use.
describe("MSW server", () => {
  it("intercepts a fetch routed through server.use", async () => {
    server.use(
      http.get("https://example.test/ping", () =>
        HttpResponse.json({ pong: true }),
      ),
    );

    const res = await fetch("https://example.test/ping");
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ pong: true });
  });
});
