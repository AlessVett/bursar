import { describe, expect, it } from "vitest";
import { amountTone, toneTextClass } from "./tones";

describe("amountTone", () => {
  it("flow: inflow is positive, outflow is ink and never danger, zero is muted", () => {
    expect(amountTone(1234)).toBe("positive");
    expect(amountTone(-1234)).toBe("ink");
    expect(amountTone(-100000000, "flow")).toBe("ink");
    expect(amountTone(0)).toBe("muted");
    expect(amountTone(-0, "flow")).toBe("muted");
  });

  it("balance: negative is danger, positive and zero are ink", () => {
    expect(amountTone(-1, "balance")).toBe("danger");
    expect(amountTone(0, "balance")).toBe("ink");
    expect(amountTone(5000, "balance")).toBe("ink");
  });

  it("net: positive is positive, negative is danger, zero is muted", () => {
    expect(amountTone(47000, "net")).toBe("positive");
    expect(amountTone(-47000, "net")).toBe("danger");
    expect(amountTone(0, "net")).toBe("muted");
  });

  it("net: the highlight option turns a negative net into ink only when it is false", () => {
    expect(amountTone(-1, "net", { highlightNegativeNet: false })).toBe("ink");
    expect(amountTone(-1, "net", { highlightNegativeNet: true })).toBe("danger");
    expect(amountTone(-1, "net", {})).toBe("danger");
    expect(amountTone(1, "net", { highlightNegativeNet: false })).toBe("positive");
    expect(amountTone(0, "net", { highlightNegativeNet: false })).toBe("muted");
  });

  it("the highlight option does not affect flow or balance", () => {
    expect(amountTone(-1, "flow", { highlightNegativeNet: true })).toBe("ink");
    expect(amountTone(-1, "balance", { highlightNegativeNet: false })).toBe("danger");
  });
});

describe("toneTextClass", () => {
  it("returns the semantic text utility of each tone", () => {
    expect(toneTextClass("positive")).toBe("text-positive");
    expect(toneTextClass("ink")).toBe("text-ink");
    expect(toneTextClass("danger")).toBe("text-danger");
    expect(toneTextClass("muted")).toBe("text-muted");
  });
});
