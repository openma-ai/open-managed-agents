/**
 * Operator container classes for SANDBOX_IMAGES catalog images.
 *
 * Wrangler binds one image to one container class, so every catalog image
 * (e.g. a Harbor task image) needs its own class exported from this worker.
 * Each must extend OmaSandbox so it keeps the backup and billing hooks of the
 * default `Sandbox`, and must be passed to withOmaOutbound: @cloudflare/containers
 * keys outbound handlers by class name, so a subclass does not inherit the
 * vault egress handler or the R2 passthrough. Add two lines per image, e.g.
 *
 *   export class SandboxFixGit extends OmaSandbox {}
 *   withOmaOutbound(SandboxFixGit);
 *
 * (import `withOmaOutbound` from "./oma-sandbox" too), then declare its
 * container, Durable Object binding and migration in apps/agent/wrangler.jsonc
 * and its alias in SANDBOX_IMAGES on apps/main. See
 * docs/cloudflare-sandbox-images.md. Intentionally empty in the repo: no task
 * images are part of the committed deployment.
 */
import { OmaSandbox } from "./oma-sandbox";

/** Keeps the import (and the documented base class) referenced. */
export type OperatorSandboxBase = OmaSandbox;
