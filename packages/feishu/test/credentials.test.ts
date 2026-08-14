import { describe, expect, it } from "vitest";

import {
  normalizeFeishuAppCredentials,
  validateFeishuAppCredentials,
} from "../src/oauth/credentials";

describe("validateFeishuAppCredentials", () => {
  it("accepts appId + appSecret alone (signing fields are optional)", () => {
    // Regression guard: encryptKey used to be required. The WS ingest path
    // (the canonical one) never reads encryptKey/verificationToken, so a
    // long-connection App must be installable with only the token-minting pair.
    const errors = validateFeishuAppCredentials({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: null,
      encryptKey: null,
    });
    expect(errors).toBeNull();
  });

  it("accepts all four when well-formed", () => {
    const errors = validateFeishuAppCredentials({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: "token-1234",
      encryptKey: "encrypt_key_16_bytes_",
    });
    expect(errors).toBeNull();
  });

  it("requires appId with the cli_ prefix", () => {
    const noPrefix = validateFeishuAppCredentials({
      appId: "aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: null,
      encryptKey: null,
    });
    expect(noPrefix?.some((e) => e.field === "appId")).toBe(true);

    const empty = validateFeishuAppCredentials({
      appId: "",
      appSecret: "secret_long_enough_16",
      verificationToken: null,
      encryptKey: null,
    });
    expect(empty?.some((e) => e.field === "appId")).toBe(true);
  });

  it("requires appSecret of adequate length", () => {
    const errors = validateFeishuAppCredentials({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "short",
      verificationToken: null,
      encryptKey: null,
    });
    expect(errors?.some((e) => e.field === "appSecret")).toBe(true);
  });

  it("length-checks the optional signing fields only when provided", () => {
    // Blank → no signing-field errors. Since appId+appSecret are valid and
    // both signing fields are empty (skipped), the whole result is null.
    const blank = validateFeishuAppCredentials({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: "",
      encryptKey: "",
    });
    expect(blank).toBeNull();

    // Too short → error (encryptKey < 16, verificationToken < 8).
    const tooShort = validateFeishuAppCredentials({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: "short",
      encryptKey: "too_short",
    });
    expect(tooShort?.some((e) => e.field === "encryptKey")).toBe(true);
    expect(tooShort?.some((e) => e.field === "verificationToken")).toBe(true);
  });
});

describe("normalizeFeishuAppCredentials", () => {
  it("trims whitespace and preserves null signing fields", () => {
    const out = normalizeFeishuAppCredentials({
      appId: "  cli_aaf77d1a63f8dbc1\n",
      appSecret: "  secret_long_enough_16  ",
      verificationToken: null,
      encryptKey: null,
    });
    expect(out).toEqual({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: null,
      encryptKey: null,
    });
  });

  it("trims provided signing fields", () => {
    const out = normalizeFeishuAppCredentials({
      appId: "cli_aaf77d1a63f8dbc1",
      appSecret: "secret_long_enough_16",
      verificationToken: "  token-1234  ",
      encryptKey: "  encrypt_key_16_bytes_  ",
    });
    expect(out.verificationToken).toBe("token-1234");
    expect(out.encryptKey).toBe("encrypt_key_16_bytes_");
  });
});
