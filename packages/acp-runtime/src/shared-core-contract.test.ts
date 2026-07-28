import { describe, expect, it } from "vitest";
import { AcpRuntimeImpl as LocalRuntime, AcpSessionImpl as LocalSession } from "./index";
import {
  AcpRuntimeImpl as SharedRuntime,
  AcpSessionImpl as SharedSession,
} from "@openma/common/acp-runtime";

describe("OpenManaged ACP package", () => {
  it("re-exports the shared ACP runtime core", () => {
    expect(LocalRuntime).toBe(SharedRuntime);
    expect(LocalSession).toBe(SharedSession);
  });
});
