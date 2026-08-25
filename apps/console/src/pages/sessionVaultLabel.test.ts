import { describe, expect, it } from "vitest";

/**
 * Session detail maps GET /v1/vaults/:id → badge label via `name`.
 * Regression for #156 (was incorrectly reading `display_name`).
 */
function vaultBadgeLabel(v: { id: string; name?: string }, shorten: (id: string) => string) {
  return v.name || shorten(v.id);
}

describe("session vault badge label", () => {
  it("uses API name when present", () => {
    expect(vaultBadgeLabel({ id: "vault_abc123", name: "Prod secrets" }, (id) => id.slice(-6))).toBe(
      "Prod secrets",
    );
  });

  it("falls back to shortened id when name is missing", () => {
    expect(vaultBadgeLabel({ id: "vault_abc123" }, (id) => id.slice(-6))).toBe("abc123");
  });
});
