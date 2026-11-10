import { describe, expect, it } from "vitest";
import { accountPatchSchema, balanceHistoryQuerySchema } from "./accounts";

describe("accountPatchSchema", () => {
  it("accepts an empty patch", () => {
    expect(accountPatchSchema.parse({})).toEqual({});
  });

  it("trims the nickname", () => {
    expect(accountPatchSchema.parse({ nickname: "  Rainy day  " })).toEqual({
      nickname: "Rainy day",
    });
  });

  it("turns an empty, blank or null nickname into null", () => {
    expect(accountPatchSchema.parse({ nickname: "" })).toEqual({ nickname: null });
    expect(accountPatchSchema.parse({ nickname: "   " })).toEqual({ nickname: null });
    expect(accountPatchSchema.parse({ nickname: null })).toEqual({ nickname: null });
  });

  it("limits the nickname to 80 characters after trimming", () => {
    expect(accountPatchSchema.safeParse({ nickname: "a".repeat(80) }).success).toBe(true);
    expect(accountPatchSchema.safeParse({ nickname: `  ${"a".repeat(80)}  ` }).success).toBe(true);
    expect(accountPatchSchema.safeParse({ nickname: "a".repeat(81) }).success).toBe(false);
  });

  it("only lets the owner switch between active and disabled", () => {
    expect(accountPatchSchema.parse({ status: "disabled" })).toEqual({ status: "disabled" });
    expect(accountPatchSchema.parse({ status: "active" })).toEqual({ status: "active" });
    expect(accountPatchSchema.safeParse({ status: "removed" }).success).toBe(false);
    expect(accountPatchSchema.safeParse({ status: "unavailable" }).success).toBe(false);
  });

  it("rejects unknown keys and a non-string nickname", () => {
    expect(accountPatchSchema.safeParse({ currency: "USD" }).success).toBe(false);
    expect(accountPatchSchema.safeParse({ nickname: 12 }).success).toBe(false);
  });
});

describe("balanceHistoryQuerySchema", () => {
  it("defaults to 90 days", () => {
    expect(balanceHistoryQuerySchema.parse({})).toEqual({ days: 90 });
  });

  it("coerces the allowed windows from text", () => {
    expect(balanceHistoryQuerySchema.parse({ days: "30" })).toEqual({ days: 30 });
    expect(balanceHistoryQuerySchema.parse({ days: "90" })).toEqual({ days: 90 });
    expect(balanceHistoryQuerySchema.parse({ days: "365" })).toEqual({ days: 365 });
  });

  it("rejects any other window", () => {
    for (const days of ["7", "0", "-30", "abc", "", "30.5"]) {
      expect(balanceHistoryQuerySchema.safeParse({ days }).success).toBe(false);
    }
  });
});
