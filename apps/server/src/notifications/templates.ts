import { isPanelPath, type NotificationEvent } from "@bursar/shared";

export type EmailLocale = "it" | "en";
export type EmailEvent = NotificationEvent | "test";

/**
 * Email text is deliberately generic: an event title and a link to the panel. `renderEmail`
 * never receives the notification params, so no amount, bank name, account name or date can end
 * up in a mailbox. The titles contain no digits; the only digits in a message come from the
 * panel URL.
 */
const TITLES: Record<EmailLocale, Record<EmailEvent, string>> = {
  en: {
    consent_expiring: "A bank connection is about to expire",
    consent_expired: "A bank connection has expired",
    connection_error: "A bank connection needs attention",
    sync_failing: "Account synchronisation keeps failing",
    backup_failing: "Backups are failing",
    test: "Test message",
  },
  it: {
    consent_expiring: "Un collegamento bancario sta per scadere",
    consent_expired: "Un collegamento bancario è scaduto",
    connection_error: "Un collegamento bancario richiede attenzione",
    sync_failing: "La sincronizzazione dei conti continua a fallire",
    backup_failing: "I backup non vanno a buon fine",
    test: "Messaggio di prova",
  },
};

const COPY: Record<EmailLocale, { open: string; footer: string }> = {
  en: {
    open: "Open Bursar for the details:",
    footer: "This message contains no financial data. Everything else is in the panel.",
  },
  it: {
    open: "Apri Bursar per i dettagli:",
    footer: "Questo messaggio non contiene dati finanziari. Il resto è nel pannello.",
  },
};

export function emailTitle(event: EmailEvent, locale: EmailLocale): string {
  return TITLES[locale][event];
}

export function renderEmail(input: { event: EmailEvent; locale: EmailLocale; panelUrl: string }): {
  subject: string;
  text: string;
} {
  const title = emailTitle(input.event, input.locale);
  const copy = COPY[input.locale];
  return {
    subject: `Bursar: ${title}`,
    text: [`${title}.`, "", copy.open, input.panelUrl, "", copy.footer, ""].join("\n"),
  };
}

/**
 * Absolute panel URL for a stored link. Links are panel paths written by the server; anything
 * else (an absolute URL, a protocol-relative `//host`, a backslash form) falls back to the panel
 * home, so a notification can never point an email reader outside the panel.
 */
export function panelUrlFor(publicUrl: URL, link: string | null): string {
  if (link !== null && isPanelPath(link)) {
    const resolved = new URL(link, publicUrl);
    if (resolved.origin === publicUrl.origin) return resolved.toString();
  }
  return new URL("/", publicUrl).toString();
}
