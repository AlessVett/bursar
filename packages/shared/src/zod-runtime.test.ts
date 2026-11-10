import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configureZodRuntime } from "./zod-runtime";

describe("configureZodRuntime", () => {
  it("switches Zod to the interpreted path only where a document exists", () => {
    configureZodRuntime({});
    expect(z.config().jitless).not.toBe(true);
    configureZodRuntime({ document: {} });
    expect(z.config().jitless).toBe(true);
    const schema = z.object({ name: z.string().min(1) });
    expect(schema.safeParse({ name: "a" }).success).toBe(true);
    expect(schema.safeParse({ name: "" }).success).toBe(false);
  });
});
