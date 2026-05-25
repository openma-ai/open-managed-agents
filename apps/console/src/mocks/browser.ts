import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

// Browser-side worker for opt-in dev mocking (e.g. running the console
// without a live backend). Not used by tests — those run in jsdom and
// use ./server instead.
export const worker = setupWorker(...handlers);
