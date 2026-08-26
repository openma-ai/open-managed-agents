import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Logo } from "./Logo";

describe("Logo", () => {
  it("uses the semantic brand color by default", () => {
    const markup = renderToStaticMarkup(
      <Logo size="lg" className="mx-auto text-fg-muted" />,
    );

    expect(markup).toContain('fill="var(--brand)"');
  });

  it("follows the surrounding foreground only when explicitly requested", () => {
    const markup = renderToStaticMarkup(<Logo tone="current" />);

    expect(markup).toContain('fill="currentColor"');
  });
});
