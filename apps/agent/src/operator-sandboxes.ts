/**
 * Operator container classes for SANDBOX_IMAGES catalog images.
 *
 * Wrangler binds one image to one container class, so every catalog image
 * (e.g. a Harbor task image) needs its own class exported from this worker.
 * Each must extend OmaSandbox so it keeps the vault egress handler, backup and
 * billing hooks of the default `Sandbox`. Add one line per image, e.g.
 *
 *   export class SandboxFixGit extends OmaSandbox {}
 *
 * then declare its container, Durable Object binding and migration in
 * apps/agent/wrangler.jsonc and its alias in SANDBOX_IMAGES on apps/main.
 * See docs/cloudflare-sandbox-images.md. Intentionally empty in the repo:
 * no task images are part of the committed deployment.
 */
import { OmaSandbox } from "./oma-sandbox";

/** Keeps the import (and the documented base class) referenced. */
export type OperatorSandboxBase = OmaSandbox;
