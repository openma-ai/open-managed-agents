import { describe, expect, it } from "vitest";
import {
  formatRuntimePairingToken,
  parseRuntimePairingToken,
} from "@open-managed-agents/api-types";
import { decodePairingToken, pairingTokenFrom } from "../src/bridge/lib/pairing.js";

const code = "0123456789abcdef0123456789abcdef";
const state = "fedcba9876543210fedcba9876543210";

describe("runtime pairing token", () => {
  it("round-trips the server-minted (code, state) pair", () => {
    const token = formatRuntimePairingToken({ code, state });
    expect(token).toBe(`omrp_${code}_${state}`);
    expect(parseRuntimePairingToken(`  ${token}\n`)).toEqual({ code, state });
    expect(decodePairingToken(token)).toEqual({ code, state });
  });

  it("rejects malformed tokens with an actionable error", () => {
    for (const bad of [
      "",
      `sk_machine_${code}`,
      `omrp_${code}`,
      `omrp_${code}_${state}_extra`,
      `omrp_${code.toUpperCase()}_${state}`,
      "omrp_abc_def",
    ]) {
      expect(parseRuntimePairingToken(bad)).toBeNull();
    }
    expect(() => decodePairingToken("nope")).toThrow(/oma runtime pair/);
    expect(() => formatRuntimePairingToken({ code: "xyz", state })).toThrow();
  });

  it("prefers --token over OMA_PAIRING_TOKEN and ignores blanks", () => {
    expect(pairingTokenFrom("omrp_a", { OMA_PAIRING_TOKEN: "omrp_b" })).toBe("omrp_a");
    expect(pairingTokenFrom(undefined, { OMA_PAIRING_TOKEN: " omrp_b " })).toBe("omrp_b");
    expect(pairingTokenFrom(undefined, { OMA_PAIRING_TOKEN: "  " })).toBeUndefined();
    expect(pairingTokenFrom(undefined, {})).toBeUndefined();
  });
});
