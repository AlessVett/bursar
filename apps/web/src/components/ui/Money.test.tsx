import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { useUi } from "../../store/ui";
import { Money } from "./Money";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useUi.setState({ privacy: false });
});
afterEach(() => {
  useUi.setState({ privacy: false });
});

describe("Money", () => {
  it("formats integer minor units in the active language and uses tabular figures", async () => {
    const { container, rerender } = render(<Money minor={12345050} currency="EUR" />);
    const span = container.querySelector("span") as HTMLElement;
    expect(span.textContent).toBe("€123,450.50");
    expect(span.className).toContain("tabular");

    await i18n.changeLanguage("it");
    rerender(<Money minor={12345050} currency="EUR" />);
    expect((container.querySelector("span") as HTMLElement).textContent).toMatch(
      /^123\.450,50\s€$/,
    );
  });

  it("shows an explicit sign when asked", () => {
    const { container } = render(<Money minor={4700} currency="EUR" sign="always" />);
    expect(container.textContent).toBe("+€47.00");
  });

  it("derives the tone from the amount: inflow green, outflow ink, never red for a flow", () => {
    const { container, rerender } = render(<Money minor={500} currency="EUR" tone="auto-flow" />);
    expect((container.firstChild as HTMLElement).className).toContain("text-positive");
    rerender(<Money minor={-500} currency="EUR" tone="auto-flow" />);
    expect((container.firstChild as HTMLElement).className).toContain("text-ink");
    expect((container.firstChild as HTMLElement).className).not.toContain("text-danger");
    rerender(<Money minor={-500} currency="EUR" tone="auto-balance" />);
    expect((container.firstChild as HTMLElement).className).toContain("text-danger");
    rerender(<Money minor={-500} currency="EUR" tone="auto-net" />);
    expect((container.firstChild as HTMLElement).className).toContain("text-danger");
    rerender(<Money minor={500} currency="EUR" tone="muted" />);
    expect((container.firstChild as HTMLElement).className).toContain("text-muted");
  });

  it("masks the amount in privacy mode, labels the mask and drops the tone", () => {
    useUi.setState({ privacy: true });
    const { container } = render(<Money minor={-12345} currency="EUR" tone="auto-flow" />);
    const masked = screen.getByRole("img", { name: "Amount hidden" });
    expect(masked.textContent).toBe("•••••");
    expect(masked.className).toContain("tabular");
    expect(masked.className).not.toContain("text-");
    expect(container.textContent).not.toMatch(/\d/);
  });
});
