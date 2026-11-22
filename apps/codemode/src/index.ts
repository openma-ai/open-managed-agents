import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

/**
 * QuickJS runs in a separate Worker so CPU-heavy code-mode scripts do not
 * block the SessionDO that owns the model loop and event stream.
 */
export class CodemodeSandbox extends CodemodeSandboxDurableObject {}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
