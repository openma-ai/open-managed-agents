import { afterEach, describe, expect, it, vi } from "vitest";
import { handleProcessFailure } from "../../../packages/control-plane-node/src/lib/db-unhandled-rejection";
import { isFetchAbortRejection } from "../../../packages/control-plane-node/src/lib/fetch-abort-rejection";
import type { Logger } from "../../../packages/observability/src/index";
import { Timeout } from "../../../packages/sql-client/src/db-errors";

function loggerStub() {
  const fatal = vi.fn();
  const logger: Logger = {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal,
    child: () => logger,
  };
  return { logger, fatal };
}

describe("fetch abort rejection classification", () => {
  it.each([
    [new DOMException("This operation was aborted", "AbortError")],
    [new DOMException("timed out", "TimeoutError")],
    [new TypeError("terminated")],
    [Object.assign(new Error("socket reset"), { code: "UND_ERR_SOCKET" })],
    [Object.assign(new Error("connection reset"), { code: "ECONNRESET" })],
    [new Error("socket hang up")],
    [new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "EPIPE" }) })],
  ])("classifies %s as a network lifecycle failure", (reason) => {
    expect(isFetchAbortRejection(reason)).toBe(true);
  });

  it.each([
    [new Error("assertion failed")],
    [new Error("business request aborted by policy")],
    [new Error("terminated")],
    [new TypeError("fetch failed")],
    ["terminated"],
    [null],
    [undefined],
  ])("does not classify %s as a network lifecycle failure", (reason) => {
    expect(isFetchAbortRejection(reason)).toBe(false);
  });
});

describe("process failure net", () => {
  afterEach(() => vi.unstubAllEnvs());

  function run(reason: unknown) {
    vi.stubEnv("NODE_ENV", "production");
    const { logger, fatal } = loggerStub();
    const exit = vi.fn();
    handleProcessFailure("unhandled_rejection", reason, { logger }, exit);
    return { exit, fatal };
  }

  it("logs but does not terminate for post-response undici termination", () => {
    const result = run(new TypeError("terminated"));
    expect(result.exit).not.toHaveBeenCalled();
    expect(result.fatal).toHaveBeenCalledOnce();
  });

  it("still terminates for an unrelated process failure", () => {
    expect(run(new Error("assertion failed")).exit).toHaveBeenCalledWith(1);
  });

  it("retains the existing lease-safe exception", () => {
    expect(run(new Timeout({ op: "sql" })).exit).not.toHaveBeenCalled();
  });
});
