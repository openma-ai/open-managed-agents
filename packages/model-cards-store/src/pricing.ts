// Model-card list pricing: parsing + validation shared by the HTTP routes
// (CF + Node) and the runtime budget gate.
import type { ModelPricing } from "./types";

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

/** "3.75" USD → 3_750_000 micro-USD. Throws on a malformed price. */
export function parseUsdPrice(value: string): bigint {
  const m = DECIMAL.exec(value);
  if (!m) throw new Error(`invalid price "${value}": expected a non-negative decimal with at most 6 fraction digits`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Validate + normalize a request body's `pricing`. Throws a user-facing
 * message on bad input. */
export function validateModelPricing(input: unknown): ModelPricing {
  if (!input || typeof input !== "object") throw new Error("pricing must be an object");
  const p = input as Record<string, unknown>;
  if (p.version !== undefined && p.version !== 1) throw new Error("pricing.version must be 1");
  if (p.currency !== undefined && p.currency !== "USD") throw new Error("pricing.currency must be USD");
  const out: ModelPricing = {
    version: 1,
    currency: "USD",
    input_per_mtok: String(p.input_per_mtok ?? ""),
    output_per_mtok: String(p.output_per_mtok ?? ""),
  };
  for (const key of ["cache_read_per_mtok", "cache_write_per_mtok"] as const) {
    if (p[key] !== undefined && p[key] !== null) out[key] = String(p[key]);
  }
  if (typeof p.effective_at === "string") {
    if (Number.isNaN(Date.parse(p.effective_at))) throw new Error("pricing.effective_at must be ISO-8601");
    out.effective_at = p.effective_at;
  }
  for (const key of ["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok"] as const) {
    if (out[key] !== undefined) {
      try { parseUsdPrice(out[key]!); } catch { throw new Error(`pricing.${key}: invalid price "${out[key]}"`); }
    }
  }
  return out;
}

