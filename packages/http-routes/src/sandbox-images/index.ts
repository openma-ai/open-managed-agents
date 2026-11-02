// Sandbox images — the operator's SANDBOX_IMAGES catalog, read-only.
//
// OMA-only (no CMA counterpart), mounted at /v1/oma/sandbox_images by both
// the Node control plane and the Cloudflare app so the Console can always
// probe it. Selections are written through `_oma.sandbox_image` on the
// managed /v1/environments routes.

import { Hono } from "hono";

/** One selectable image as exposed to API clients and the Console. The
 * provider reference is deliberately not part of this shape: it can reveal
 * internal registry hosts and is never needed to make a selection. */
export interface SandboxImageListingView {
  alias: string;
  label: string;
  description: string | null;
}

export interface SandboxImageListingSource {
  list(): SandboxImageListingView[];
}

/**
 * GET / — the operator's SANDBOX_IMAGES catalog, for `_oma.sandbox_image`.
 * Read-only; an empty `data` array means only the default image exists.
 */
export function buildSandboxImageRoutes(source: SandboxImageListingSource): Hono {
  const app = new Hono();
  app.get("/", (c) =>
    c.json({
      data: source.list().map((image) => ({
        type: "sandbox_image",
        alias: image.alias,
        label: image.label,
        description: image.description,
      })),
    }),
  );
  return app;
}
