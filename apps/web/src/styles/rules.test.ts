import { describe, expect, it } from "vitest";

// Sources of the panel, tests excluded. `?raw` gives the text without running anything.
const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/** UX doc section 5: components use semantic utilities only. */
const FORBIDDEN: [string, RegExp][] = [
  ["dark: variant", /(?:^|[\s"'`])dark:/],
  ["bg-white / text-white / bg-black / text-black", /\b(?:bg|text)-(?:white|black)\b/],
  [
    "Tailwind palette colour",
    new RegExp(
      `\\b(?:bg|text|border|ring|divide|outline|fill|stroke|from|via|to|shadow|placeholder|accent|caret|decoration)-(?:${PALETTE})-\\d{2,3}\\b`,
    ),
  ],
  ["hex colour literal", /["'`]#[0-9a-fA-F]{3,8}["'`]/],
];

describe("panel sources", () => {
  it("are found", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN)("contain no %s", (_name, pattern) => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => pattern.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
