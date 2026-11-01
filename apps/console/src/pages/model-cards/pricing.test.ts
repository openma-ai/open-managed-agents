import { describe, expect, it } from "vitest";
import { pricingFromForm, pricingToForm } from "./pricing";

describe("model card pricing form", () => {
  it("empty means unpriced", () => {
    expect(pricingFromForm({ input: "", output: "", cache_read: "", cache_write: "" })).toEqual({ pricing: null });
  });
  it("builds versioned pricing", () => {
    expect(pricingFromForm({ input: "$3", output: "15", cache_read: "0.30", cache_write: "" })).toEqual({
      pricing: { version: 1, currency: "USD", input_per_mtok: "3", output_per_mtok: "15", cache_read_per_mtok: "0.30" },
    });
  });
  it("validates", () => {
    expect(pricingFromForm({ input: "3", output: "", cache_read: "", cache_write: "" })).toEqual({ error: "required" });
    expect(pricingFromForm({ input: "3", output: "abc", cache_read: "", cache_write: "" })).toEqual({ error: "invalid" });
  });
  it("round-trips", () => {
    expect(pricingToForm({ input_per_mtok: "3", output_per_mtok: "15", cache_write_per_mtok: "3.75" }))
      .toEqual({ input: "3", output: "15", cache_read: "", cache_write: "3.75" });
  });
});
