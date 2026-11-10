import type { CashFlowBucket } from "@bursar/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { FormatProvider } from "../../lib/format";
import { useUi } from "../../store/ui";
import { CashFlowStrip, type CashFlowStripProps, toChartRows } from "./CashFlowStrip";
import { bucketLabel, dayMonthLabel, tokenColor } from "./chart-colors";

// jsdom has no layout: give the chart a fixed size instead of measuring its parent.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const { cloneElement } = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>;
    }) => cloneElement(children, { width: 600, height: 200 }),
  };
});

const BUCKETS: CashFlowBucket[] = [
  {
    date: "2026-11-01",
    end: "2026-11-01",
    inMinor: 250_000,
    outMinor: 1_200,
    netMinor: 248_800,
    count: 2,
    balanceMinor: 748_800,
  },
  {
    date: "2026-11-02",
    end: "2026-11-02",
    inMinor: 0,
    outMinor: 0,
    netMinor: 0,
    count: 0,
    balanceMinor: 748_800,
  },
  {
    date: "2026-11-03",
    end: "2026-11-03",
    inMinor: 0,
    outMinor: 4_550,
    netMinor: -4_550,
    count: 3,
    balanceMinor: 744_250,
  },
];

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at ${index}`);
  return item;
}

function renderStrip(overrides: Partial<CashFlowStripProps> = {}) {
  return render(
    <FormatProvider timeZone="Europe/Rome">
      <CashFlowStrip
        buckets={BUCKETS}
        currency="EUR"
        variant="full"
        highlightNegativeNet
        summaryLabel="Cash flow"
        {...overrides}
      />
    </FormatProvider>,
  );
}

function periodButtons(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Cash flow: choose a period" })).getAllByRole(
    "button",
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useUi.setState({ privacy: false });
});

afterEach(() => {
  useUi.setState({ privacy: false });
});

describe("chart helpers", () => {
  it("plot outflows (non-negative magnitudes from the API) below zero", () => {
    const rows = toChartRows([at(BUCKETS, 0), at(BUCKETS, 2)]);
    expect(rows.map((row) => row.outflow)).toEqual([-1_200, -4_550]);
    expect(at(rows, 1)).toMatchObject({ inflow: 0, net: -4_550, balance: 744_250 });
  });

  it("turn a token triplet into a colour and fall back to the variable", () => {
    expect(tokenColor(" 21 128 61", "--positive")).toBe("rgb(21 128 61)");
    expect(tokenColor("", "--positive")).toBe("rgb(var(--positive))");
  });

  it("label days and ranges without a year", () => {
    expect(dayMonthLabel("2026-11-05", "en-GB")).toBe("5 Nov");
    expect(dayMonthLabel("2026-11-05", "it-IT")).toBe("5 nov");
    expect(bucketLabel({ date: "2026-11-02", end: "2026-11-08" }, "en-GB")).toBe("2 Nov – 8 Nov");
    expect(bucketLabel({ date: "2026-11-02", end: "2026-11-02" }, "en-GB")).toBe("2 Nov");
  });
});

describe("CashFlowStrip", () => {
  it("summarises the period for screen readers", () => {
    renderStrip();
    expect(
      screen.getByText(
        "Cash flow, from 1 Nov 2026 to 3 Nov 2026: in €2,500.00, out €57.50, net +€2,442.50. Balance at the end of the period: €7,442.50.",
      ),
    ).toBeTruthy();
  });

  it("lets the keyboard move between periods and select one", () => {
    const onSelect = vi.fn();
    renderStrip({ onSelectBucket: onSelect });
    const buttons = periodButtons();
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, 0]);
    expect(at(buttons, 0).getAttribute("aria-label")).toBe(
      "1 Nov: in €2,500.00, out €12.00, net +€2,488.00, 2 transactions",
    );

    at(buttons, 2).focus();
    fireEvent.keyDown(at(buttons, 2), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(at(buttons, 1));
    fireEvent.keyDown(at(buttons, 1), { key: "Home" });
    expect(document.activeElement).toBe(at(buttons, 0));
    fireEvent.click(at(buttons, 0));
    expect(onSelect).toHaveBeenCalledWith(at(BUCKETS, 0));
  });

  it("marks the selected period as pressed and starts the tab order there", () => {
    renderStrip({ onSelectBucket: vi.fn(), selectedDate: "2026-11-02" });
    const buttons = periodButtons();
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("shows a tooltip with the figures of the focused period", () => {
    renderStrip({ onSelectBucket: vi.fn() });
    expect(screen.queryByText("+€2,488.00")).toBeNull();
    // A bare focus() is not wrapped in act: React would flush the state update in a microtask.
    act(() => at(periodButtons(), 0).focus());
    expect(screen.getByText("+€2,488.00")).toBeTruthy();
    expect(screen.getByText("€7,488.00")).toBeTruthy();
    expect(screen.getByText("2 transactions")).toBeTruthy();
  });

  it("masks every amount in privacy mode", () => {
    useUi.setState({ privacy: true });
    renderStrip({ onSelectBucket: vi.fn() });
    const summary = screen.getByText(/^Cash flow, from/);
    expect(summary.textContent).toContain("•••••");
    expect(summary.textContent).not.toContain("€");
    expect(at(periodButtons(), 0).getAttribute("aria-label")).not.toContain("€");
  });

  it("renders the mini variant without the period list or the balance sentence", () => {
    renderStrip({ variant: "mini" });
    expect(screen.queryByRole("list")).toBeNull();
    const summary = screen.getByText(/^Cash flow, from/);
    expect(summary.textContent).not.toContain("Balance");
  });

  it("draws the chart once the lazily loaded module arrives", async () => {
    const { container } = renderStrip();
    await waitFor(() => expect(container.querySelector(".recharts-surface")).not.toBeNull());
  });
});
