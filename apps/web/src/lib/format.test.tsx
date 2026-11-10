import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelativeTime } from "../components/ui/RelativeTime";
import i18n from "../i18n";
import { FormatProvider, localeFor, useFormatters } from "./format";

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

function wrapper(timeZone?: string) {
  return ({ children }: { children: ReactNode }) => (
    <FormatProvider {...(timeZone ? { timeZone } : {})}>{children}</FormatProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useFormatters", () => {
  it("maps the language to a locale", () => {
    expect(localeFor("it")).toBe("it-IT");
    expect(localeFor("en")).toBe("en-GB");
    expect(localeFor("en-US")).toBe("en-GB");
  });

  it("formats money, relative and absolute times and local dates in English", () => {
    const { result } = renderHook(() => useFormatters(), { wrapper: wrapper("Europe/Rome") });
    expect(result.current.locale).toBe("en-GB");
    expect(result.current.timeZone).toBe("Europe/Rome");
    expect(result.current.money(-123450, "EUR")).toBe("-€1,234.50");
    expect(result.current.money(123450, "EUR", { masked: true })).toBe("•••••");
    expect(result.current.relative(NOW - 2 * 3_600_000)).toBe("2 hours ago");
    expect(result.current.absolute(NOW, true)).toContain("13:00");
    expect(result.current.localDate("2026-11-09")).toMatch(/9 Nov 2026/);
    expect(result.current.relativeDay("2026-11-08")).toBe("Yesterday");
    expect(result.current.now()).toBe(NOW);
  });

  it("switches to Italian when the language changes", async () => {
    const { result } = renderHook(() => useFormatters(), { wrapper: wrapper("Europe/Rome") });
    await act(async () => {
      await i18n.changeLanguage("it");
    });
    expect(result.current.locale).toBe("it-IT");
    expect(result.current.relative(NOW - 2 * 3_600_000)).toBe("2 ore fa");
    expect(result.current.localDate("2026-11-09")).toMatch(/9 nov 2026/);
  });

  it("works without a provider and falls back to the browser zone for an unknown zone", () => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const bare = renderHook(() => useFormatters());
    expect(bare.result.current.timeZone).toBe(browser);
    const invalid = renderHook(() => useFormatters(), { wrapper: wrapper("Not/AZone") });
    expect(invalid.result.current.timeZone).toBe(browser);
  });

  it("returns the same object until the language or the zone changes", () => {
    const { result, rerender } = renderHook(() => useFormatters(), {
      wrapper: wrapper("Europe/Rome"),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("RelativeTime", () => {
  it("renders a time element with the ISO instant and the absolute date with time in the title", () => {
    render(
      <FormatProvider timeZone="Europe/Rome">
        <RelativeTime at={NOW - 3_600_000} />
      </FormatProvider>,
    );
    const element = screen.getByText("1 hour ago");
    expect(element.tagName).toBe("TIME");
    expect(element.getAttribute("datetime")).toBe(new Date(NOW - 3_600_000).toISOString());
    expect(element.getAttribute("title")).toContain("12:00");
  });

  it("shows a dash instead of 'Invalid Date' for a missing instant", () => {
    render(<RelativeTime at={Number.NaN} />);
    expect(screen.queryByText("—")).not.toBeNull();
  });
});
