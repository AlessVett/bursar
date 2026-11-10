import type { LocalDate } from "@bursar/shared";
import { useEffect, useState } from "react";
import type { AmountTone } from "../../lib/tones";

/*
 * Chart helpers shared by the cash-flow strip and its lazily loaded Recharts module:
 * colours read from the theme variables, layout constants and label formatters.
 * Nothing here imports Recharts, so the main bundle stays small.
 */

export type ChartVariant = "full" | "mini" | "aggregate";

/** One bucket as the chart draws it: inflow above zero, outflow below zero (always ≤ 0). */
export interface ChartRow {
  date: LocalDate;
  inflow: number;
  outflow: number;
  net: number;
  balance: number | null;
}

export interface ChartColors {
  positive: string;
  ink: string;
  danger: string;
  muted: string;
  primary: string;
  grid: string;
  surface: string;
}

const COLOR_VARIABLES: Record<keyof ChartColors, string> = {
  positive: "--positive",
  ink: "--ink",
  danger: "--danger",
  muted: "--muted",
  primary: "--primary",
  grid: "--border",
  surface: "--surface",
};

const TRIPLET = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/;

/**
 * tokens.css stores colours as RGB triplets ("21 128 61"). SVG attributes get a resolved
 * `rgb(…)` value; when the variable is not set (jsdom) the CSS reference is kept.
 */
export function tokenColor(value: string, variable: string): string {
  const match = TRIPLET.exec(value.trim());
  return match ? `rgb(${match[1]} ${match[2]} ${match[3]})` : `rgb(var(${variable}))`;
}

export function readChartColors(root: HTMLElement = document.documentElement): ChartColors {
  const style = getComputedStyle(root);
  const read = (name: keyof ChartColors) =>
    tokenColor(style.getPropertyValue(COLOR_VARIABLES[name]), COLOR_VARIABLES[name]);
  return {
    positive: read("positive"),
    ink: read("ink"),
    danger: read("danger"),
    muted: read("muted"),
    primary: read("primary"),
    grid: read("grid"),
    surface: read("surface"),
  };
}

/** Theme colours for SVG attributes, re-read whenever `data-theme` changes on <html>. */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(() => readChartColors());
  useEffect(() => {
    const root = document.documentElement;
    setColors(readChartColors(root));
    const observer = new MutationObserver(() => setColors(readChartColors(root)));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

export function toneColor(colors: ChartColors, tone: AmountTone): string {
  switch (tone) {
    case "positive":
      return colors.positive;
    case "danger":
      return colors.danger;
    case "muted":
      return colors.muted;
    default:
      return colors.ink;
  }
}

export interface ChartLayout {
  margin: { top: number; right: number; bottom: number; left: number };
  /** Height reserved for the visible date axis; 0 when the axis is hidden. */
  xAxisHeight: number;
}

/** Shared by the chart and the keyboard overlay so that the overlay buttons sit on the bars. */
export const CHART_LAYOUT: Record<ChartVariant, ChartLayout> = {
  full: { margin: { top: 12, right: 8, bottom: 0, left: 8 }, xAxisHeight: 24 },
  aggregate: { margin: { top: 6, right: 4, bottom: 6, left: 4 }, xAxisHeight: 0 },
  mini: { margin: { top: 2, right: 0, bottom: 2, left: 0 }, xAxisHeight: 0 },
};

/** The plot area inside the chart box, in pixels from each edge. */
export function overlayInset(variant: ChartVariant): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const { margin, xAxisHeight } = CHART_LAYOUT[variant];
  return {
    top: margin.top,
    right: margin.right,
    bottom: margin.bottom + xAxisHeight,
    left: margin.left,
  };
}

const dayMonthFormats = new Map<string, Intl.DateTimeFormat>();

/** "5 Nov" / "5 nov": a calendar date without the year, never shifted by a time zone. */
export function dayMonthLabel(date: LocalDate, locale: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  let format = dayMonthFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short" });
    dayMonthFormats.set(locale, format);
  }
  return format.format(Date.UTC(year, month - 1, day));
}

/** A day bucket is its date; a week or month bucket is its first and last day. */
export function bucketLabel(bucket: { date: LocalDate; end: LocalDate }, locale: string): string {
  if (bucket.date === bucket.end) return dayMonthLabel(bucket.date, locale);
  return `${dayMonthLabel(bucket.date, locale)} – ${dayMonthLabel(bucket.end, locale)}`;
}
