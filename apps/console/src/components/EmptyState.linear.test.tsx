import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { EmptyState } from "./EmptyState";

describe("EmptyState composition", () => {
  it("accepts rich body copy without nesting paragraphs", () => {
    const { container } = render(
      <EmptyState title="No agents yet" body={<p>Create your first agent.</p>} />,
    );

    expect(container.querySelector("p p")).toBeNull();
  });
});
