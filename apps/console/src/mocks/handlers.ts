import type { HttpHandler } from "msw";

// MSW handlers shared across the whole test suite. Tests opt in to
// specific responses with `server.use(http.get(...))` rather than
// relying on a big global registry, so this list stays small — only
// add a handler here when many tests would otherwise duplicate it.
export const handlers: HttpHandler[] = [];
