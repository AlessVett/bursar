import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Urgency, urgencyClasses } from "../../lib/thresholds";
import { DeadlineChip } from "./DeadlineChip";

const URGENCIES: Urgency[] = ["danger", "warning", "ok"];

describe("DeadlineChip", () => {
  it.each(URGENCIES)("states the deadline as text for the %s urgency", (urgency) => {
    const { container } = render(
      <DeadlineChip
        urgency={urgency}
        label="Consent expires in 9 days"
        title="Expires on 18 Nov"
      />,
    );
    const chip = screen.getByText("Consent expires in 9 days");
    expect(chip.getAttribute("data-urgency")).toBe(urgency);
    expect(chip.getAttribute("title")).toBe("Expires on 18 Nov");
    for (const token of urgencyClasses(urgency).split(" ")) expect(chip.className).toContain(token);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses a different icon for each urgency, so colour is not the only signal", () => {
    const icons = URGENCIES.map((urgency) => {
      const { container, unmount } = render(<DeadlineChip urgency={urgency} label="x" />);
      const name = container.querySelector("svg")?.getAttribute("class") ?? "";
      unmount();
      return name;
    });
    expect(new Set(icons).size).toBe(3);
  });
});
