import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { FormatProvider } from "../../lib/format";
import { useUi } from "../../store/ui";
import { NetChip } from "./NetChip";

function chip(netMinor: number, highlightNegativeNet?: boolean) {
  render(
    <FormatProvider timeZone="Europe/Rome">
      <NetChip netMinor={netMinor} currency="EUR" highlightNegativeNet={highlightNegativeNet} />
    </FormatProvider>,
  );
  const root = document.querySelector("[data-net-chip]");
  if (!(root instanceof HTMLElement)) throw new Error("NetChip not rendered");
  return root;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useUi.setState({ privacy: false });
});

afterEach(() => {
  useUi.setState({ privacy: false });
});

describe("NetChip", () => {
  it("shows a positive net with a plus sign in the positive tone", () => {
    const root = chip(47_000);
    expect(screen.getByText("+€470.00")).toBeTruthy();
    expect(root.dataset.tone).toBe("positive");
    expect(root.className).toContain("text-positive");
    expect(screen.getByText("Net, last 30 days: +€470.00")).toBeTruthy();
  });

  it("shows a negative net in the danger tone by default", () => {
    const root = chip(-1_200);
    expect(screen.getByText("-€12.00")).toBeTruthy();
    expect(root.dataset.tone).toBe("danger");
  });

  it("uses the ink tone for a negative net when highlighting is off", () => {
    const root = chip(-1_200, false);
    expect(root.dataset.tone).toBe("ink");
    expect(root.className).toContain("text-ink");
  });

  it("shows a zero net as muted without a sign", () => {
    const root = chip(0);
    expect(screen.getByText("€0.00")).toBeTruthy();
    expect(root.dataset.tone).toBe("muted");
  });

  it("masks the amount in privacy mode", () => {
    useUi.setState({ privacy: true });
    const root = chip(47_000);
    expect(root.textContent).not.toContain("470");
    expect(screen.getByText("•••••")).toBeTruthy();
    expect(screen.getByText("Net, last 30 days: Amount hidden")).toBeTruthy();
  });
});
