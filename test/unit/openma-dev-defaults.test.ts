/**
 * Regression guard for #411 — hosted defaults must not fall back to
 * `openma.dev`.
 *
 * The hosted product lives on `openma.ai` (#424, #432, #455). These three
 * surfaces are the ones that actually ship to end users:
 *
 *   - `apps/console/index.html` — canonical / Open Graph / Twitter card
 *     URLs the console advertises to crawlers and link previews.
 *   - `DEFAULT_EMAIL_FROM` (`apps/main/src/auth-config.ts`) — the From
 *     header on OTP / verification / reset mail.
 *   - `DEFAULT_FROM` (`packages/email/src/index.ts`) — the runtime-agnostic
 *     email port's default sender.
 *
 * Deliberately NOT asserted here: the wrangler `custom_domain` entries,
 * `INTEGRATIONS_ORIGIN` / `GATEWAY_ORIGIN`, and the `*.staging.openma.dev`
 * hosts. Those are ops-owned DNS decisions and are still tracked on #411 —
 * this guard must not fail the monorepo over them.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_EMAIL_FROM } from "../../apps/main/src/auth-config";
import { DEFAULT_FROM } from "../../packages/email/src/index";
// `?raw` inlines the file at transform time. The Cloudflare test pool
// sandboxes `node:fs` to a few writable dirs, so the console bootstrap
// HTML is not readable from disk at runtime.
import consoleIndexHtml from "../../apps/console/index.html?raw";

describe("hosted openma.dev leftovers", () => {
  it("keeps the console bootstrap metadata on openma.ai", () => {
    expect(consoleIndexHtml).not.toContain("openma.dev");
    expect(consoleIndexHtml).toContain("https://app.openma.ai/");
  });

  it("keeps the auth email defaults on openma.ai", () => {
    expect(DEFAULT_EMAIL_FROM).not.toContain("openma.dev");
    expect(DEFAULT_EMAIL_FROM).toBe("openma <noreply@openma.ai>");
    expect(DEFAULT_FROM).not.toContain("openma.dev");
    expect(DEFAULT_FROM).toBe("openma <noreply@openma.ai>");
  });
});
