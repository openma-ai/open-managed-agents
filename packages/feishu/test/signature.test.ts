import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  computeEncryptKeyChallenge,
  computeVerificationTokenChallenge,
  constantTimeEqual,
  detectSigningMode,
} from "../src/webhook/signature";

describe("webhook/signature", () => {
  describe("detectSigningMode", () => {
    it("prefers encrypt_key when both are set with sufficient length", () => {
      // 32-char base64 encrypt key wins over verification token
      const ek = "A".repeat(32);
      const vt = "tok_short";
      expect(detectSigningMode(ek, vt)).toBe("encrypt_key");
    });

    it("falls back to verification_token when encrypt key is too short", () => {
      // Real behavior: a too-short encryptKey (< 16 chars) doesn't qualify,
      // so the function falls through to the verification_token branch.
      expect(detectSigningMode("short", "verification_token_xyz")).toBe("verification_token");
    });

    it("uses verification_token when no encrypt_key is set", () => {
      expect(detectSigningMode(null, "abc123")).toBe("verification_token");
    });

    it("defaults to encrypt_key when both are empty", () => {
      expect(detectSigningMode(null, null)).toBe("encrypt_key");
    });

    it("treats empty-string encrypt_key as missing", () => {
      // Falsy string → falls through to verification_token
      expect(detectSigningMode("", "vt_xyz")).toBe("verification_token");
    });
  });

  describe("computeEncryptKeyChallenge", () => {
    it("computes HMAC-SHA256('') keyed by challenge, base64-encoded", async () => {
      const challenge = "test-challenge-12345";
      // Reference impl: HMAC-SHA256 over empty string, key=challenge, base64
      const expected = createHmac("sha256", challenge).update("").digest("base64");
      const got = await computeEncryptKeyChallenge("ignored-encrypt-key", challenge);
      expect(got).toBe(expected);
    });

    it("returns a non-empty base64 string", async () => {
      const got = await computeEncryptKeyChallenge("k", "c");
      expect(got.length).toBeGreaterThan(0);
      // base64 alphabet check (incl. padding = + /)
      expect(got).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("uses challenge as the HMAC key, not the encryptKey arg", async () => {
      // Two calls with different encryptKey but same challenge → same result.
      // The function name says computeEncryptKeyChallenge but the wire-level
      // Feishu spec uses the challenge as the key (encryptKey is only for
      // signature verification of event payloads, not URL challenges).
      const a = await computeEncryptKeyChallenge("encrypt-A", "fixed");
      const b = await computeEncryptKeyChallenge("encrypt-B", "fixed");
      expect(a).toBe(b);
    });
  });

  describe("computeVerificationTokenChallenge", () => {
    it("echoes the challenge verbatim", () => {
      expect(computeVerificationTokenChallenge("hello")).toBe("hello");
    });

    it("preserves whitespace and special characters", () => {
      const c = "with spaces & special: !@#$%^&*()";
      expect(computeVerificationTokenChallenge(c)).toBe(c);
    });

    it("returns empty string for empty input", () => {
      expect(computeVerificationTokenChallenge("")).toBe("");
    });
  });

  describe("constantTimeEqual", () => {
    it("returns true for identical strings", () => {
      expect(constantTimeEqual("abc", "abc")).toBe(true);
    });

    it("returns false for different-length strings", () => {
      expect(constantTimeEqual("abc", "abcd")).toBe(false);
    });

    it("returns false for same-length strings with different content", () => {
      expect(constantTimeEqual("abc", "abd")).toBe(false);
    });

    it("returns true for empty strings", () => {
      expect(constantTimeEqual("", "")).toBe(true);
    });

    it("returns false when one char differs", () => {
      expect(constantTimeEqual("abcdef", "abcdez")).toBe(false);
    });
  });
});
