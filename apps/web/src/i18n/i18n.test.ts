import { describe, expect, it } from "vitest";
import english from "./en.json";
import italian from "./it.json";

function flatten(value: object, prefix = ""): Record<string, unknown> {
  return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, child]) => {
    if (typeof child === "object" && child !== null)
      Object.assign(acc, flatten(child, `${prefix}${key}.`));
    else acc[`${prefix}${key}`] = child;
    return acc;
  }, {});
}

describe("translations", () => {
  it("define the same keys in Italian and English", () => {
    expect(Object.keys(flatten(italian)).sort()).toEqual(Object.keys(flatten(english)).sort());
  });

  it("contain no empty strings", () => {
    for (const value of [...Object.values(flatten(italian)), ...Object.values(flatten(english))]) {
      expect(typeof value === "string" && value.trim().length > 0).toBe(true);
    }
  });
});
