import { render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useUi } from "../../store/ui";
import { axisTicks, BalanceChart, balanceDomain, buildBalanceRows } from "./BalanceChart";

vi.mock("recharts", async (importOriginal) => {
  const original = await importOriginal<typeof import("recharts")>();
  return {
    ...original,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width?: number; height?: number }>;
    }) => cloneElement(children, { width: 600, height: 240 }),
  };
});

const POSITIVE = [
  { date: "2026-11-01", balanceMinor: 100_000 },
  { date: "2026-11-02", balanceMinor: 120_000 },
  { date: "2026-11-03", balanceMinor: 90_000 },
];
const DIPPING = [
  { date: "2026-11-01", balanceMinor: 20_000 },
  { date: "2026-11-02", balanceMinor: -10_000 },
  { date: "2026-11-03", balanceMinor: -30_000 },
  { date: "2026-11-04", balanceMinor: 5_000 },
];

describe("buildBalanceRows", () => {
  it("keeps one row per point when the balance never changes sign", () => {
    const rows = buildBalanceRows(POSITIVE);
    expect(rows.map((row) => row.x)).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.negative === null)).toBe(true);
  });
  it("adds an interpolated row at each zero crossing", () => {
    const rows = buildBalanceRows(DIPPING);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 1, 2, 3, 3]);
    expect(rows[1]?.x).toBeCloseTo(2 / 3, 5);
    expect(rows[1]).toMatchObject({ positive: 0, negative: 0 });
    expect(rows[4]?.x).toBeCloseTo(2 + 6 / 7, 5);
    expect(rows[0]).toMatchObject({ positive: 20_000, negative: null });
    expect(rows[2]).toMatchObject({ positive: null, negative: -10_000 });
  });
  it("treats a zero balance as both sides without a crossing row", () => {
    const rows = buildBalanceRows([
      { date: "2026-11-01", balanceMinor: 5 },
      { date: "2026-11-02", balanceMinor: 0 },
      { date: "2026-11-03", balanceMinor: -5 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ positive: 0, negative: 0 });
  });
});

describe("balanceDomain and axisTicks", () => {
  it("keeps a series that stays positive above zero", () => {
    const [low, high] = balanceDomain([100, 100]);
    expect(low).toBe(0);
    expect(high).toBe(200);
  });
  it("includes zero when the series dips below it", () => {
    const [low, high] = balanceDomain([-500, -100]);
    expect(low).toBeLessThan(-500);
    expect(high).toBe(0);
  });
  it("spreads at most five ticks over the indices", () => {
    expect(axisTicks(90)).toEqual([0, 22, 45, 67, 89]);
    expect(axisTicks(2)).toEqual([0, 1]);
  });
});

describe("BalanceChart", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.style.setProperty("--primary", "30 42 74");
    document.documentElement.style.setProperty("--danger", "185 28 28");
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--danger");
    useUi.setState({ privacy: false });
  });

  it("describes the chart for screen readers", () => {
    render(
      <BalanceChart
        points={POSITIVE}
        currency="EUR"
        summaryLabel="Balance from 1,000.00 to 900.00"
      />,
    );
    expect(screen.getByRole("img", { name: "Balance from 1,000.00 to 900.00" })).not.toBeNull();
  });

  it("draws a series that stays positive in the primary colour only", () => {
    const { container } = render(
      <BalanceChart points={POSITIVE} currency="EUR" summaryLabel="s" />,
    );
    const strokes = [...container.querySelectorAll("path.recharts-area-curve")].map((path) =>
      path.getAttribute("stroke"),
    );
    expect(strokes).toEqual(["rgb(30 42 74)"]);
  });

  it("draws the negative stretch in the danger colour", () => {
    const { container } = render(<BalanceChart points={DIPPING} currency="EUR" summaryLabel="s" />);
    const strokes = [...container.querySelectorAll("path.recharts-area-curve")].map((path) =>
      path.getAttribute("stroke"),
    );
    expect(strokes).toContain("rgb(30 42 74)");
    expect(strokes).toContain("rgb(185 28 28)");
    expect(container.querySelector(".recharts-reference-line")).not.toBeNull();
  });

  it("hides the value axis in privacy mode", () => {
    const { container, rerender } = render(
      <BalanceChart points={POSITIVE} currency="EUR" summaryLabel="s" />,
    );
    expect(container.querySelector(".recharts-yAxis")).not.toBeNull();
    useUi.setState({ privacy: true });
    rerender(<BalanceChart points={POSITIVE} currency="EUR" summaryLabel="s" />);
    expect(container.querySelector(".recharts-yAxis")).toBeNull();
  });

  it("renders nothing with fewer than two points", () => {
    const { container } = render(
      <BalanceChart points={POSITIVE.slice(0, 1)} currency="EUR" summaryLabel="s" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
