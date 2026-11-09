import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

describe("createLogger", () => {
  it("redacts secrets at the top level and one level deep", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger("info", sink);
    logger.info(
      { password: "hunter2-secret", nested: { token: "tok-secret" }, keep: "visible" },
      "test",
    );
    const output = lines.join("");
    expect(output).not.toContain("hunter2-secret");
    expect(output).not.toContain("tok-secret");
    expect(output).toContain("visible");
    expect(output).toContain("[redacted]");
  });
});
