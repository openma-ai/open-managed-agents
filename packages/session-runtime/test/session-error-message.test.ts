import { expect, it } from "vitest";
import { sessionErrorMessage } from "../src/session-error-message";

it("includes phase, error class and the complete cause chain even when messages are empty", () => {
  const root = new TypeError("socket closed");
  const error = new Error("", { cause: new Error("", { cause: root }) });
  expect(sessionErrorMessage(error, "storage.sync:turn_end")).toBe("storage.sync:turn_end: Error: (empty message); caused by Error: (empty message); caused by TypeError: socket closed");
});
it("never returns an empty message and stops cyclic causes", () => {
  for (const error of ["", " ", null, undefined, {}, new Error("")]) expect(sessionErrorMessage(error, "turn").trim()).not.toBe("");
  const error = new Error("");
  error.cause = error;
  expect(sessionErrorMessage(error, "turn")).toContain("[cyclic cause]");
});
