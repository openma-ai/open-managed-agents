import type { ComponentType, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Page } from "./Page";

type RailPageProps = {
  layout: "rail";
  rail: ReactNode;
  children: ReactNode;
};

describe("Page Linear detail contract", () => {
  it("keeps primary content and metadata in stable detail-rail slots", () => {
    const RailPage = Page as unknown as ComponentType<RailPageProps>;

    render(
      <RailPage layout="rail" rail={<aside>Agent properties</aside>}>
        <article>Agent narrative</article>
      </RailPage>,
    );

    const layout = screen.getByTestId("detail-layout");
    expect(layout).toHaveAttribute("data-detail-layout", "rail");
    expect(screen.getByTestId("detail-body")).toContainElement(
      screen.getByText("Agent narrative"),
    );
    expect(screen.getByTestId("detail-rail")).toContainElement(
      screen.getByText("Agent properties"),
    );
  });
});
