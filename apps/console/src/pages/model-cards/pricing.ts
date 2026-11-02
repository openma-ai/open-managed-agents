// Model-card list pricing (USD per 1M tokens) form helpers.
export interface PricingForm {
  input: string;
  output: string;
  cache_read: string;
  cache_write: string;
}

export const EMPTY_PRICING_FORM: PricingForm = { input: "", output: "", cache_read: "", cache_write: "" };

const PRICE = /^\d+(\.\d{1,6})?$/;

export function pricingToForm(pricing: unknown): PricingForm {
  const p = (pricing ?? {}) as Record<string, string | undefined>;
  return {
    input: p.input_per_mtok ?? "",
    output: p.output_per_mtok ?? "",
    cache_read: p.cache_read_per_mtok ?? "",
    cache_write: p.cache_write_per_mtok ?? "",
  };
}

/** Form → API `pricing`. All empty → null (unpriced). Input and output are
 * required when any price is set; cache prices are optional. */
export function pricingFromForm(
  form: PricingForm,
): { pricing: Record<string, unknown> | null } | { error: "required" | "invalid" } {
  const v = {
    input: form.input.trim().replace(/^\$/, ""),
    output: form.output.trim().replace(/^\$/, ""),
    cache_read: form.cache_read.trim().replace(/^\$/, ""),
    cache_write: form.cache_write.trim().replace(/^\$/, ""),
  };
  if (Object.values(v).every((x) => x === "")) return { pricing: null };
  if (v.input === "" || v.output === "") return { error: "required" };
  if (Object.values(v).some((x) => x !== "" && !PRICE.test(x))) return { error: "invalid" };
  return {
    pricing: {
      version: 1,
      currency: "USD",
      input_per_mtok: v.input,
      output_per_mtok: v.output,
      ...(v.cache_read && { cache_read_per_mtok: v.cache_read }),
      ...(v.cache_write && { cache_write_per_mtok: v.cache_write }),
    },
  };
}
