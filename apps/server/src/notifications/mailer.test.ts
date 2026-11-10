import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../config";
import { type SmtpStub, startSmtpStub } from "../test/smtp-stub";
import { createSmtpMailer, describeMailError, MemoryMailer, smtpTransportOptions } from "./mailer";

type Smtp = NonNullable<Config["smtp"]>;

const smtp = (overrides: Partial<Smtp> = {}): Smtp => ({
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  user: "bursar",
  password: "not-a-real-password",
  from: "Bursar <bursar@example.test>",
  ...overrides,
});

describe("smtpTransportOptions", () => {
  it("requires the STARTTLS upgrade in starttls mode", () => {
    expect(smtpTransportOptions(smtp())).toMatchObject({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      auth: { user: "bursar", pass: "not-a-real-password" },
      tls: { minVersion: "TLSv1.2" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  });

  it("uses implicit TLS in tls mode", () => {
    expect(smtpTransportOptions(smtp({ security: "tls", port: 465 }))).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
  });

  it("turns TLS off only in none mode", () => {
    expect(smtpTransportOptions(smtp({ security: "none", host: "127.0.0.1" }))).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it("sends no credentials when none are configured", () => {
    expect(smtpTransportOptions(smtp({ user: null, password: null })).auth).toBeUndefined();
  });
});

describe("MemoryMailer", () => {
  it("records messages", async () => {
    const mailer = new MemoryMailer();
    await mailer.send({ to: "owner@example.test", subject: "Subject", text: "Body" });
    expect(mailer.sent).toEqual([{ to: "owner@example.test", subject: "Subject", text: "Body" }]);
  });

  it("fails once when asked to, then recovers", async () => {
    const mailer = new MemoryMailer();
    mailer.failNext = new Error("boom");
    await expect(mailer.send({ to: "a@example.test", subject: "s", text: "t" })).rejects.toThrow(
      "boom",
    );
    expect(mailer.sent).toHaveLength(0);
    await mailer.send({ to: "a@example.test", subject: "s", text: "t" });
    expect(mailer.sent).toHaveLength(1);
    mailer.failNext = new Error("verify failed");
    await expect(mailer.verify()).rejects.toThrow("verify failed");
    await expect(mailer.verify()).resolves.toBeUndefined();
  });
});

describe("describeMailError", () => {
  it("keeps only the error code and the SMTP status", () => {
    const error = Object.assign(new Error("535 5.7.8 bad credentials for mario@example.test"), {
      code: "EAUTH",
      responseCode: 535,
      response: "535 5.7.8 bad credentials for mario@example.test",
    });
    expect(describeMailError(error)).toBe("SMTP delivery failed (EAUTH, 535)");
  });

  it("falls back to a generic message", () => {
    expect(describeMailError(new Error("secret-token in the message"))).toBe(
      "SMTP delivery failed",
    );
    expect(describeMailError("a string")).toBe("SMTP delivery failed");
    expect(describeMailError(Object.assign(new Error("x"), { code: "not a code!" }))).toBe(
      "SMTP delivery failed",
    );
  });
});

describe("createSmtpMailer", () => {
  let stub: SmtpStub | null = null;
  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  const loopback = (port: number): Smtp =>
    smtp({ host: "127.0.0.1", port, security: "none", user: null, password: null });

  it("delivers a plain-text message through an SMTP server", async () => {
    stub = await startSmtpStub();
    const mailer = createSmtpMailer(loopback(stub.port));
    await mailer.verify();
    await mailer.send({
      to: "owner@example.test",
      subject: "Bursar: Test message",
      text: "Test message.\n\nhttps://bursar.example.test/settings\n",
    });
    expect(stub.messages).toHaveLength(1);
    const message = stub.messages[0] ?? "";
    expect(message).toContain("From: Bursar <bursar@example.test>");
    expect(message).toContain("To: owner@example.test");
    expect(message).toContain("Subject: Bursar: Test message");
    expect(message).toContain("https://bursar.example.test/settings");
  });

  it("rejects when the server refuses the recipient, with a reducible error", async () => {
    stub = await startSmtpStub({ rejectRecipients: true });
    const mailer = createSmtpMailer(loopback(stub.port));
    const error = await mailer.send({ to: "owner@example.test", subject: "s", text: "t" }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect(describeMailError(error)).toBe("SMTP delivery failed (EENVELOPE, 550)");
  });

  it("rejects when nothing listens on the port", async () => {
    stub = await startSmtpStub();
    const port = stub.port;
    await stub.close();
    stub = null;
    const mailer = createSmtpMailer(loopback(port));
    await expect(
      mailer.send({ to: "owner@example.test", subject: "s", text: "t" }),
    ).rejects.toThrow();
  });
});
