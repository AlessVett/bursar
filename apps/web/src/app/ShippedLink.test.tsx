import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { isRouteShipped, ShippedLink } from "./ShippedLink";

describe("ShippedLink", () => {
  it("links to a shipped route with its search and hash", () => {
    render(
      <MemoryRouter>
        <ShippedLink route="home" search={{ day: "2026-11-05" }} hash="top">
          Home
        </ShippedLink>
      </MemoryRouter>,
    );
    expect(isRouteShipped("home")).toBe(true);
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe(
      "/?day=2026-11-05#top",
    );
  });

  it("renders plain text for a route that is not shipped", () => {
    render(
      <MemoryRouter>
        <ShippedLink route="documents" className="link" plainClassName="plain">
          Documents
        </ShippedLink>
      </MemoryRouter>,
    );
    expect(isRouteShipped("documents")).toBe(false);
    expect(screen.queryByRole("link")).toBeNull();
    const text = screen.getByText("Documents");
    expect(text.tagName).toBe("SPAN");
    expect(text.className).toBe("plain");
  });

  it("renders nothing for an unshipped route when asked to hide", () => {
    render(
      <MemoryRouter>
        <ShippedLink route="documents" whenUnshipped="hide">
          Hidden action
        </ShippedLink>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Hidden action")).toBeNull();
  });
});
