import { notificationEventSchema } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import { emailTitle, panelUrlFor, renderEmail } from "./templates";

const EVENTS = [...notificationEventSchema.options, "test"] as const;
const LOCALES = ["it", "en"] as const;
const PANEL_URL = "https://bursar.example.test/accounts";

describe("renderEmail", () => {
  it.each(LOCALES.flatMap((locale) => EVENTS.map((event) => ({ locale, event }))))(
    "renders $event in $locale as a title and a panel link",
    ({ locale, event }) => {
      const { subject, text } = renderEmail({ event, locale, panelUrl: PANEL_URL });
      expect(subject).toBe(`Bursar: ${emailTitle(event, locale)}`);
      expect(text.startsWith(`${emailTitle(event, locale)}.\n`)).toBe(true);
      expect(text).toContain(`\n${PANEL_URL}\n`);
      expect(text).not.toMatch(/undefined|\{|\}/);
      // The only digits in a message belong to the panel URL.
      expect(`${subject}\n${text.replace(PANEL_URL, "")}`).not.toMatch(/\d/);
    },
  );

  it("has a different title for every event and each language", () => {
    for (const locale of LOCALES) {
      const titles = EVENTS.map((event) => emailTitle(event, locale));
      expect(new Set(titles).size).toBe(EVENTS.length);
    }
    expect(emailTitle("backup_failing", "it")).not.toBe(emailTitle("backup_failing", "en"));
  });

  it("mentions that no financial data is included", () => {
    expect(renderEmail({ event: "test", locale: "en", panelUrl: PANEL_URL }).text).toContain(
      "contains no financial data",
    );
    expect(renderEmail({ event: "test", locale: "it", panelUrl: PANEL_URL }).text).toContain(
      "non contiene dati finanziari",
    );
  });
});

describe("panelUrlFor", () => {
  const publicUrl = new URL("https://bursar.example.test");

  it("resolves panel paths, keeping the fragment", () => {
    expect(panelUrlFor(publicUrl, "/accounts/12")).toBe("https://bursar.example.test/accounts/12");
    expect(panelUrlFor(publicUrl, "/settings#backups")).toBe(
      "https://bursar.example.test/settings#backups",
    );
  });

  it("falls back to the panel home for no link or anything that is not a panel path", () => {
    for (const link of [
      null,
      "",
      "accounts",
      "https://evil.example.test/",
      "//evil.example.test/",
      "/\\evil.example.test",
      "javascript:alert(1)",
    ]) {
      expect(panelUrlFor(publicUrl, link)).toBe("https://bursar.example.test/");
    }
  });
});
