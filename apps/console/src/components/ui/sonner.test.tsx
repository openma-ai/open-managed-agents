import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { Toaster } from "./sonner";

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ effective: "light" }),
}));

describe("Toaster presentation", () => {
  afterEach(() => {
    toast.dismiss();
  });

  it("expands notifications instead of rendering collapsed card shells", async () => {
    render(<Toaster />);
    toast.error("HTTP 500");

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toast]')).toHaveAttribute(
        "data-expanded",
        "true",
      );
    });
  });

  it("uses the console semantic tokens for error notifications", async () => {
    render(<Toaster />);
    toast.error("HTTP 500");

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toast]')).toHaveAttribute(
        "data-rich-colors",
        "true",
      );
    });

    const toaster = document.querySelector<HTMLElement>(
      '[data-sonner-toaster]',
    );
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("var(--bg)");
    expect(toaster?.style.getPropertyValue("--error-bg")).toBe(
      "var(--danger-subtle)",
    );
    expect(toaster?.style.getPropertyValue("--error-text")).toBe(
      "var(--danger)",
    );
  });
});
