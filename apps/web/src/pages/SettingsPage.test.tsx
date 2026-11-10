import type { BackupStatusResponse, BankStatusResponse, SettingsResponse } from "@bursar/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts } from "../components/feedback";
import { Toaster } from "../components/ui";
import i18n from "../i18n";
import { renderRoutes, stubApi } from "../test/router";
import { SettingsPage } from "./SettingsPage";

type Handler = (body: unknown) => { status: number; body?: unknown };

const HOUR_MS = 3_600_000;

const SETTINGS: SettingsResponse = {
  values: {
    locale: "en",
    country: "IT",
    consentDays: 180,
    backgroundSyncCap: 2,
    dailySyncTime: "06:00",
    backupTime: "03:00",
    notificationEmail: "owner@example.test",
    emailNotifications: true,
    highlightNegativeNet: true,
  },
  system: {
    timezone: "Europe/Rome",
    publicUrl: "https://bursar.example.test",
    enableBankingConfigured: true,
    smtpConfigured: true,
    backupTarget: "local",
  },
};

const BANK_STATUS: BankStatusResponse = {
  configured: true,
  environment: "SANDBOX",
  active: true,
  redirectUrlAllowed: true,
  countries: ["IT"],
  error: null,
};

function backups(overrides: Partial<BackupStatusResponse> = {}): BackupStatusResponse {
  const now = Date.now();
  return {
    target: "local",
    lastSuccessAt: now - 7 * HOUR_MS,
    consecutiveFailures: 3,
    runs: [
      {
        id: 2,
        trigger: "scheduled",
        status: "failed",
        target: "local",
        setId: null,
        startedAt: now - 2 * HOUR_MS,
        finishedAt: now - 2 * HOUR_MS + 5_000,
        sizeBytes: null,
        errorMessage: "Upload failed",
      },
      {
        id: 1,
        trigger: "manual",
        status: "succeeded",
        target: "local",
        setId: null,
        startedAt: now - 7 * HOUR_MS,
        finishedAt: now - 7 * HOUR_MS + 42_000,
        sizeBytes: 1_843_200,
        errorMessage: null,
      },
    ],
    ...overrides,
  };
}

interface Rendered {
  fetchMock: ReturnType<typeof stubApi>;
  patches: unknown[];
  posts: string[];
}

function renderSettings(
  overrides: Record<string, Handler> = {},
  options: { hash?: string } = {},
): Rendered {
  const patches: unknown[] = [];
  const posts: string[] = [];
  const fetchMock = stubApi({
    "GET /api/settings": () => ({ status: 200, body: SETTINGS }),
    "GET /api/banks/status": () => ({ status: 200, body: BANK_STATUS }),
    "GET /api/backups": () => ({ status: 200, body: backups() }),
    "PATCH /api/settings": (body) => {
      patches.push(body);
      return {
        status: 200,
        body: { ...SETTINGS, values: { ...SETTINGS.values, ...(body as object) } },
      };
    },
    "POST /api/backups/run": () => {
      posts.push("backups/run");
      return { status: 202, body: { queued: true } };
    },
    "POST /api/notifications/test-email": () => {
      posts.push("test-email");
      return { status: 202, body: { sent: true } };
    },
    ...overrides,
  });
  renderRoutes(
    [
      {
        path: "/settings",
        element: (
          <>
            <SettingsPage />
            <Toaster />
          </>
        ),
      },
    ],
    { initialEntries: [`/settings${options.hash ?? ""}`] },
  );
  return { fetchMock, patches, posts };
}

const region = (name: string) => screen.getByRole("region", { name });
const unsavedBar = () => screen.queryByRole("region", { name: "Unsaved changes" });

describe("SettingsPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearToasts();
    globalThis.localStorage?.removeItem("bursar.language");
    await i18n.changeLanguage("en");
  });

  it("shows the five sections with the saved values in read mode", async () => {
    renderSettings();
    await screen.findByRole("region", { name: "General" });
    for (const name of ["General", "Banking", "Notifications", "Display", "Backups"]) {
      expect(region(name)).not.toBeNull();
    }
    const general = within(region("General"));
    expect(general.getByText("English")).not.toBeNull();
    expect(general.getByText("Italy")).not.toBeNull();
    expect(general.getByText("Europe/Rome")).not.toBeNull();
    const banking = within(region("Banking"));
    expect(banking.getByText("180 days")).not.toBeNull();
    expect(banking.getByText("2 per account per day")).not.toBeNull();
    expect(banking.getByText("06:00")).not.toBeNull();
    const notifications = within(region("Notifications"));
    expect(notifications.getByText("owner@example.test")).not.toBeNull();
    expect(within(region("Display")).getByText("On")).not.toBeNull();
    expect(within(region("Backups")).getByText("03:00")).not.toBeNull();
    expect(unsavedBar()).toBeNull();
  });

  it("previews the chosen language live and restores it on cancel", async () => {
    renderSettings();
    const general = await screen.findByRole("region", { name: "General" });
    expect(general.textContent).toContain("€1,234.56");
    fireEvent.click(screen.getByRole("button", { name: "Edit section General" }));
    fireEvent.change(within(general).getByLabelText("Language"), { target: { value: "it" } });
    expect(general.textContent).toMatch(/1\.234,56/);
    await screen.findByRole("region", { name: "Unsaved changes" });
    fireEvent.click(within(general).getByRole("button", { name: "Cancel" }));
    expect(general.textContent).toContain("€1,234.56");
    await waitFor(() => expect(unsavedBar()).toBeNull());
  });

  it("saves the General section, switches the language and confirms in the new language", async () => {
    const { patches } = renderSettings();
    const general = await screen.findByRole("region", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section General" }));
    fireEvent.change(within(general).getByLabelText("Language"), { target: { value: "it" } });
    fireEvent.click(screen.getByRole("button", { name: "Save section General" }));
    expect(await screen.findByText("Impostazioni salvate")).not.toBeNull();
    expect(patches).toContainEqual({ locale: "it", country: "IT" });
    expect(i18n.language).toBe("it");
    expect(globalThis.localStorage?.getItem("bursar.language")).toBe("it");
    expect(await screen.findByRole("heading", { level: 1, name: "Impostazioni" })).not.toBeNull();
  });

  it("saves two dirty sections from the unsaved bar", async () => {
    const { patches } = renderSettings();
    await screen.findByRole("region", { name: "Banking" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Banking" }));
    fireEvent.change(screen.getByLabelText("Consent length (days)"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Display" }));
    fireEvent.click(screen.getByRole("switch", { name: "Highlight negative net" }));
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    expect(bar.textContent).toContain("2 sections");
    fireEvent.click(within(bar).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches).toContainEqual({
      consentDays: 90,
      backgroundSyncCap: 2,
      dailySyncTime: "06:00",
    });
    expect(patches).toContainEqual({ highlightNegativeNet: false });
    await waitFor(() => expect(unsavedBar()).toBeNull());
    expect(screen.getByRole("button", { name: "Edit section Banking" })).not.toBeNull();
  });

  it("discards every dirty section from the unsaved bar without sending anything", async () => {
    const { patches } = renderSettings();
    await screen.findByRole("region", { name: "Banking" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Banking" }));
    fireEvent.change(screen.getByLabelText("Consent length (days)"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Display" }));
    fireEvent.click(screen.getByRole("switch", { name: "Highlight negative net" }));
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    fireEvent.click(within(bar).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(unsavedBar()).toBeNull());
    expect(patches).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Edit section Banking" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit section Display" })).not.toBeNull();
  });

  it("asks the browser to confirm leaving only while a section is dirty", async () => {
    renderSettings();
    await screen.findByRole("region", { name: "Banking" });
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Edit section Banking" }));
    fireEvent.change(screen.getByLabelText("Consent length (days)"), { target: { value: "90" } });
    await screen.findByRole("region", { name: "Unsaved changes" });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    fireEvent.keyDown(screen.getByLabelText("Consent length (days)"), { key: "Escape" });
    await waitFor(() => expect(unsavedBar()).toBeNull());
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("shows a field error and sends nothing when a value is invalid", async () => {
    const { patches } = renderSettings();
    await screen.findByRole("region", { name: "Banking" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Banking" }));
    fireEvent.change(screen.getByLabelText("Consent length (days)"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save section Banking" }));
    expect(
      await screen.findByText("Enter a whole number of days between 1 and 365."),
    ).not.toBeNull();
    expect(await screen.findByText("Check the highlighted fields")).not.toBeNull();
    expect(patches).toHaveLength(0);
    expect(screen.getByLabelText("Consent length (days)").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("warns and stays in edit mode when the server refuses the values", async () => {
    renderSettings({
      "PATCH /api/settings": () => ({
        status: 400,
        body: { error: "Invalid settings", code: "invalid_settings" },
      }),
    });
    await screen.findByRole("region", { name: "Display" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Display" }));
    fireEvent.click(screen.getByRole("switch", { name: "Highlight negative net" }));
    fireEvent.click(screen.getByRole("button", { name: "Save section Display" }));
    expect(await screen.findByText("Check the highlighted fields")).not.toBeNull();
    expect(within(region("Display")).getByRole("button", { name: "Cancel" })).not.toBeNull();
    expect(screen.queryByText("Settings saved")).toBeNull();
  });

  it("cancels a section edit with Escape", async () => {
    renderSettings();
    await screen.findByRole("region", { name: "Banking" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Banking" }));
    fireEvent.keyDown(screen.getByLabelText("Consent length (days)"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Edit section Banking" })).not.toBeNull();
  });

  it("explains that Enable Banking is not configured", async () => {
    renderSettings({
      "GET /api/banks/status": () => ({
        status: 200,
        body: {
          configured: false,
          environment: null,
          active: null,
          redirectUrlAllowed: null,
          countries: [],
          error: null,
        } satisfies BankStatusResponse,
      }),
    });
    expect(await screen.findByText("Enable Banking is not configured")).not.toBeNull();
  });

  it("shows the Enable Banking environment and the redirect check", async () => {
    renderSettings({
      "GET /api/banks/status": () => ({
        status: 200,
        body: { ...BANK_STATUS, redirectUrlAllowed: false } satisfies BankStatusResponse,
      }),
    });
    expect(await screen.findByText("Sandbox")).not.toBeNull();
    expect(screen.getByText("Application active")).not.toBeNull();
    expect(screen.getByText("Redirect URL not allowed")).not.toBeNull();
  });

  it("sends a test email and confirms it", async () => {
    const { posts } = renderSettings();
    await screen.findByRole("region", { name: "Notifications" });
    expect(screen.getByText("SMTP is configured")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText("Test email sent")).not.toBeNull();
    expect(posts).toEqual(["test-email"]);
  });

  it.each([
    [409, "smtp_not_configured", "SMTP is not configured on the server, so no email can be sent."],
    [409, "recipient_missing", "Save a notification address first."],
    [
      502,
      "smtp_failed",
      "The mail server refused the message. Check the SMTP settings on the server.",
    ],
  ])("explains the %i %s outcome of the test email", async (status, code, message) => {
    renderSettings({
      "POST /api/notifications/test-email": () => ({
        status,
        body: { error: "Refused", code },
      }),
    });
    await screen.findByRole("region", { name: "Notifications" });
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByText(message)).not.toBeNull();
    expect(screen.queryByText("Test email sent")).toBeNull();
  });

  it("blocks the test email while the notifications section has unsaved edits", async () => {
    renderSettings();
    await screen.findByRole("region", { name: "Notifications" });
    fireEvent.click(screen.getByRole("button", { name: "Edit section Notifications" }));
    const button = screen.getByRole("button", { name: "Send test email" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Save the changes first: the test goes to the saved address.");
  });

  it("warns that a local-only backup target keeps the copies on the server", async () => {
    renderSettings();
    expect(await screen.findByText("Backups stay on this server")).not.toBeNull();
    const backupsCard = within(region("Backups"));
    expect(backupsCard.getByText("Local copy only")).not.toBeNull();
    expect(backupsCard.getByText("3 failures in a row")).not.toBeNull();
    expect(backupsCard.getByText("Upload failed")).not.toBeNull();
    expect(backupsCard.getByText("1.8 MB")).not.toBeNull();
    expect(backupsCard.queryByText("Never")).toBeNull();
  });

  it("shows no warning and no failures for a healthy S3 target", async () => {
    renderSettings({
      "GET /api/backups": () => ({
        status: 200,
        body: backups({ target: "s3", consecutiveFailures: 0 }),
      }),
    });
    expect(await screen.findByText("S3-compatible storage")).not.toBeNull();
    expect(screen.queryByText("Backups stay on this server")).toBeNull();
    expect(screen.getByText("None")).not.toBeNull();
  });

  it("starts a backup and confirms it", async () => {
    const { posts } = renderSettings();
    await screen.findByText("Backups stay on this server");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Backup started")).not.toBeNull();
    expect(posts).toEqual(["backups/run"]);
  });

  it("explains a 409 when a backup is already running", async () => {
    renderSettings({
      "POST /api/backups/run": () => ({
        status: 409,
        body: { error: "A backup is already running", code: "backup_in_progress" },
      }),
    });
    await screen.findByText("Backups stay on this server");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("A backup is already running")).not.toBeNull();
    expect(screen.queryByText("Backup started")).toBeNull();
  });

  it("disables Back up now while a run is in progress", async () => {
    const now = Date.now();
    renderSettings({
      "GET /api/backups": () => ({
        status: 200,
        body: backups({
          runs: [
            {
              id: 3,
              trigger: "manual",
              status: "running",
              target: "local",
              setId: null,
              startedAt: now - 5_000,
              finishedAt: null,
              sizeBytes: null,
              errorMessage: null,
            },
          ],
        }),
      }),
    });
    await screen.findByText("A backup is running…");
    const button = screen.getByRole("button", { name: "Back up now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("shows an error state with a retry when the settings cannot be loaded", async () => {
    let calls = 0;
    renderSettings({
      "GET /api/settings": () => {
        calls += 1;
        return { status: 500, body: { error: "Internal error" } };
      },
    });
    expect(await screen.findByText("Settings could not be loaded")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "General" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls).toBeGreaterThan(1));
  });

  it("keeps the backups card reachable at the #backups anchor", async () => {
    renderSettings({}, { hash: "#backups" });
    const card = await screen.findByRole("region", { name: "Backups" });
    expect(card.id).toBe("backups");
  });
});
