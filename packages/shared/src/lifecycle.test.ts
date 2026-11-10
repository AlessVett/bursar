import { describe, expect, it } from "vitest";
import {
  disconnectResponseSchema,
  purgeRequestSchema,
  purgeResponseSchema,
  removalPreviewSchema,
} from "./lifecycle";

describe("lifecycle DTOs", () => {
  it("accepts only an explicit purge confirmation", () => {
    expect(purgeRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }, null]) {
      expect(purgeRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("describes a removal preview with whole, non-negative counts", () => {
    const preview = { bankName: "Banca Esempio", accounts: 2, transactions: 1534 };
    expect(removalPreviewSchema.parse(preview)).toEqual(preview);
    expect(
      removalPreviewSchema.safeParse({ bankName: "Banca Esempio", accounts: -1, transactions: 0 })
        .success,
    ).toBe(false);
    expect(
      removalPreviewSchema.safeParse({ bankName: "Banca Esempio", accounts: 1, transactions: 2.5 })
        .success,
    ).toBe(false);
  });

  it("describes the disconnect and purge responses", () => {
    expect(disconnectResponseSchema.parse({ removedAccounts: 2 })).toEqual({ removedAccounts: 2 });
    expect(purgeResponseSchema.parse({ transactions: 120, balances: 14 })).toEqual({
      transactions: 120,
      balances: 14,
    });
  });
});
