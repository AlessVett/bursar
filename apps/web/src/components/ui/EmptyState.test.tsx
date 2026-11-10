import { render, screen } from "@testing-library/react";
import { Landmark } from "lucide-react";
import { describe, expect, it } from "vitest";
import { type EmptyKind, EmptyState, InlineEmpty } from "./EmptyState";

const KINDS: EmptyKind[] = ["filter", "empty", "positive", "state", "notFound"];

describe("EmptyState", () => {
  it.each(KINDS)("renders title, description and action for the %s kind", (kind) => {
    const { container } = render(
      <EmptyState
        kind={kind}
        title="Nothing to show"
        description="Try again later."
        action={<button type="button">Do the first step</button>}
      />,
    );
    expect(screen.queryByText("Nothing to show")).not.toBeNull();
    expect(screen.queryByText("Try again later.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Do the first step" })).not.toBeNull();
    expect(container.querySelector(`[data-kind="${kind}"]`)).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("omits the description and the action when they are not given", () => {
    const { container } = render(<EmptyState kind="positive" title="All good" />);
    expect(screen.queryByText("All good")).not.toBeNull();
    expect(container.querySelectorAll("p").length).toBe(1);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("accepts a custom icon", () => {
    const { container } = render(<EmptyState kind="empty" icon={Landmark} title="No banks" />);
    expect(container.querySelector("svg.lucide-landmark")).not.toBeNull();
  });
});

describe("InlineEmpty", () => {
  it("renders a small empty with an optional description", () => {
    const { container } = render(
      <InlineEmpty title="No notifications" description="New events appear here." />,
    );
    expect(screen.queryByText("No notifications")).not.toBeNull();
    expect(screen.queryByText("New events appear here.")).not.toBeNull();
    expect(container.querySelector('[data-kind="inline"]')).not.toBeNull();
  });
});
