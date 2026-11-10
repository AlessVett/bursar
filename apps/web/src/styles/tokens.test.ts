import { describe, expect, it } from "vitest";
import stylesheet from "../styles.css?raw";
import tokensCss from "./tokens.css?raw";

type Theme = Record<string, string>;

/** Declarations of the rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): Theme {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!rule) throw new Error(`tokens.css has no rule for ${selector}`);
  const result: Theme = {};
  for (const match of (rule[1] ?? "").matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    result[match[1] ?? ""] = (match[2] ?? "").trim();
  }
  return result;
}

const light = declarations(tokensCss, ":root");
const dark = declarations(tokensCss, ':root[data-theme="dark"]');

function rgb(triplet: string): [number, number, number] {
  const match = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/.exec(triplet);
  if (!match) throw new Error(`Not an RGB triplet: "${triplet}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hex(triplet: string): string {
  return `#${rgb(triplet)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function luminance(triplet: string): number {
  const [r, g, b] = rgb(triplet).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(theme: Theme, foreground: string, background: string): number {
  const a = luminance(theme[foreground] ?? "");
  const b = luminance(theme[background] ?? "");
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** UX doc section 5, token table. */
const UX_TABLE: Record<"light" | "dark", Record<string, string>> = {
  light: {
    bg: "#F6F7F9",
    surface: "#FFFFFF",
    "surface-2": "#F1F3F7",
    border: "#E3E7EE",
    text: "#141A26",
    muted: "#5B6475",
    primary: "#1E2A4A",
    "primary-50": "#EEF1F8",
    accent: "#B07A22",
    positive: "#15803D",
    ink: "#334155",
    warning: "#B45309",
    "warning-bg": "#FEF3C7",
    danger: "#B91C1C",
    "danger-bg": "#FEE2E2",
    info: "#1D4ED8",
    "info-bg": "#DBEAFE",
  },
  dark: {
    bg: "#0E121B",
    surface: "#151B27",
    "surface-2": "#1C2433",
    border: "#273043",
    text: "#E7EAF1",
    muted: "#9AA4B6",
    primary: "#9DB0E0",
    "primary-50": "#1E2840",
    accent: "#D9A74A",
    positive: "#4ADE80",
    ink: "#CBD5E1",
    warning: "#FBBF24",
    "warning-bg": "#3A2A0B",
    danger: "#F87171",
    "danger-bg": "#3B1416",
    info: "#60A5FA",
    "info-bg": "#13233F",
  },
};

const SURFACES = ["bg", "surface", "surface-2"];

/** Text pairs that components really use: WCAG AA, 4.5:1. */
const TEXT_PAIRS: [string, string][] = [
  ...["text", "muted", "primary", "positive", "ink", "danger", "warning", "info"].flatMap(
    (foreground): [string, string][] => SURFACES.map((surface) => [foreground, surface]),
  ),
  ["text", "primary-50"],
  ["muted", "primary-50"],
  ["primary", "primary-50"],
  ["warning", "warning-bg"],
  ["danger", "danger-bg"],
  ["info", "info-bg"],
  // Accent badge. `text` on `accent` is 1.8:1 in dark mode, so the badge uses `on-accent`.
  ["on-accent", "accent"],
  // Label of a primary button (`bg-primary text-bg`).
  ["bg", "primary"],
];

/** Bars and dots, not text: WCAG non-text contrast, 3:1. */
const NON_TEXT_PAIRS: [string, string][] = [
  ["accent", "surface"],
  ["accent", "bg"],
];

describe("tokens.css", () => {
  it("defines the same tokens in light and dark", () => {
    const names = (theme: Theme) =>
      Object.keys(theme)
        .filter((name) => name !== "color-scheme")
        .sort();
    expect(names(dark)).toEqual(names(light).filter((name) => name !== "row-height"));
  });

  it.each(["light", "dark"] as const)("matches the UX token table in %s mode", (mode) => {
    const theme = mode === "light" ? light : dark;
    for (const [name, expected] of Object.entries(UX_TABLE[mode])) {
      expect(hex(theme[name] ?? ""), `${mode} --${name}`).toBe(expected);
    }
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("meets WCAG AA for every text pair in %s mode", (mode, theme) => {
    for (const [foreground, background] of TEXT_PAIRS) {
      const ratio = contrast(theme, foreground, background);
      expect(
        ratio,
        `${mode}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("meets 3:1 for non-text pairs in %s mode", (mode, theme) => {
    for (const [foreground, background] of NON_TEXT_PAIRS) {
      const ratio = contrast(theme, foreground, background);
      expect(
        ratio,
        `${mode}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("sets the row height per density", () => {
    expect(declarations(tokensCss, ':root[data-density="compact"]')["row-height"]).toBe("40px");
    expect(declarations(tokensCss, ':root[data-density="comfortable"]')["row-height"]).toBe("56px");
  });
});

describe("styles.css theme mapping", () => {
  const MAPPING: Record<string, string> = {
    bg: "bg",
    surface: "surface",
    "surface-2": "surface-2",
    subtle: "border",
    fg: "text",
    muted: "muted",
    primary: "primary",
    "primary-50": "primary-50",
    accent: "accent",
    "on-accent": "on-accent",
    positive: "positive",
    ink: "ink",
    warning: "warning",
    "warning-soft": "warning-bg",
    danger: "danger",
    "danger-soft": "danger-bg",
    info: "info",
    "info-soft": "info-bg",
  };

  it.each(Object.entries(MAPPING))("maps the %s utility to --%s", (utility, variable) => {
    expect(stylesheet).toContain(`--color-${utility}: rgb(var(--${variable}));`);
    expect(light[variable], `--${variable} missing in tokens.css`).toBeDefined();
  });

  it("declares the fonts and the tabular utility", () => {
    expect(stylesheet).toContain(
      '--font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;',
    );
    expect(stylesheet).toContain(
      '--font-display: "Manrope Variable", "Inter Variable", sans-serif;',
    );
    expect(stylesheet).toMatch(/@utility tabular\s*\{\s*font-variant-numeric: tabular-nums;/);
  });
});
