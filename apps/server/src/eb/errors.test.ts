import { describe, expect, it } from "vitest";
import { classifyEbError, EnableBankingError, parseEbErrorBody } from "./errors";
import expiredSession from "./fixtures/error-expired-session.json";
import psuHeader from "./fixtures/error-psu-header.json";
import rateLimit from "./fixtures/error-rate-limit.json";

describe("classifyEbError", () => {
  it("asks for re-authorisation when the session is gone", () => {
    for (const code of [
      "EXPIRED_SESSION",
      "CLOSED_SESSION",
      "REVOKED_SESSION",
      "SESSION_DOES_NOT_EXIST",
      "WRONG_SESSION_STATUS",
    ]) {
      expect(classifyEbError(401, code)).toBe("reauth");
      expect(classifyEbError(400, code)).toBe("reauth");
    }
  });

  it("flags account-level problems", () => {
    expect(classifyEbError(404, "ACCOUNT_DOES_NOT_EXIST")).toBe("account");
    expect(classifyEbError(403, "ASPSP_ACCOUNT_NOT_ACCESSIBLE")).toBe("account");
  });

  it("recognises the bank rate limit by code or by status", () => {
    expect(classifyEbError(429, "ASPSP_RATE_LIMIT_EXCEEDED")).toBe("rate_limited");
    expect(classifyEbError(400, "ASPSP_RATE_LIMIT_EXCEEDED")).toBe("rate_limited");
    expect(classifyEbError(429, null)).toBe("rate_limited");
  });

  it("retries transient failures", () => {
    expect(classifyEbError(500, "ASPSP_ERROR")).toBe("retry");
    expect(classifyEbError(408, "ASPSP_TIMEOUT")).toBe("retry");
    expect(classifyEbError(0, null)).toBe("retry");
    expect(classifyEbError(408, null)).toBe("retry");
    expect(classifyEbError(500, null)).toBe("retry");
    expect(classifyEbError(503, null)).toBe("retry");
  });

  it("treats configuration and request errors as fatal", () => {
    expect(classifyEbError(401, "AUTHORIZATION_NOT_PROVIDED")).toBe("fatal");
    expect(classifyEbError(400, "REDIRECT_URI_NOT_ALLOWED")).toBe("fatal");
    expect(classifyEbError(422, "PSU_HEADER_NOT_PROVIDED")).toBe("fatal");
    expect(classifyEbError(422, "WRONG_TRANSACTIONS_PERIOD")).toBe("fatal");
    expect(classifyEbError(400, "ALREADY_AUTHORIZED")).toBe("fatal");
    expect(classifyEbError(401, null)).toBe("fatal");
    expect(classifyEbError(404, null)).toBe("fatal");
  });
});

describe("parseEbErrorBody", () => {
  it("reads the documented error bodies", () => {
    const expired = parseEbErrorBody(401, expiredSession);
    expect(expired).toBeInstanceOf(EnableBankingError);
    expect(expired).toBeInstanceOf(Error);
    expect(expired.name).toBe("EnableBankingError");
    expect([expired.status, expired.code, expired.kind]).toEqual([
      401,
      "EXPIRED_SESSION",
      "reauth",
    ]);
    expect(expired.message).toBe("Enable Banking error 401 EXPIRED_SESSION: Session expired");

    const limited = parseEbErrorBody(429, rateLimit);
    expect([limited.code, limited.kind]).toEqual(["ASPSP_RATE_LIMIT_EXCEEDED", "rate_limited"]);

    const psu = parseEbErrorBody(422, psuHeader);
    expect([psu.code, psu.kind]).toEqual(["PSU_HEADER_NOT_PROVIDED", "fatal"]);
    expect(psu.detail).toBe("PSU header psuIpAddress is not provided");
    expect(psu.message).toBe(
      "Enable Banking error 422 PSU_HEADER_NOT_PROVIDED: Required PSU header is not provided",
    );
    expect(psu.message).not.toContain("psuIpAddress");
  });

  it("tolerates missing or malformed fields", () => {
    const noCode = parseEbErrorBody(400, { message: "Bad request" });
    expect([noCode.code, noCode.detail, noCode.kind]).toEqual([null, null, "fatal"]);

    const empty = parseEbErrorBody(502, null);
    expect(empty.message).toBe("Enable Banking error 502: Unexpected response");
    expect(empty.kind).toBe("retry");

    const odd = parseEbErrorBody(400, { error: "<script>", message: 42 });
    expect(odd.code).toBeNull();
    expect(odd.message).toBe("Enable Banking error 400: Unexpected response");
  });

  it("truncates long provider messages", () => {
    const long = parseEbErrorBody(400, {
      message: "x".repeat(5000),
      error: "WRONG_REQUEST_PARAMETERS",
    });
    expect(long.message.length).toBeLessThan(260);
  });
});
