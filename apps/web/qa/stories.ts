import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type {
  AccountDetailResponse,
  AccountSummary,
  ConnectionsResponse,
  NotificationListResponse,
  SettingsResponse,
} from "@bursar/shared";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import {
  attachProbe,
  buildWeb,
  CAPTURES,
  errorMessage,
  launchBrowser,
  newCaptureContext,
  OUT_DIR,
  startQaServer,
} from "./lib";

/**
 * End-to-end stories (skill Phase 6): each one is a chain of real clicks against a fresh QA
 * server whose bank is the offline fake (Task 10), with visible results to assert on.
 *
 *   pnpm --filter @bursar/web qa:stories [--skip-build] [--only 1,3]
 *
 * Output: one line per story, `Stories: <p> passed, <f> failed`, then `Review shots: …`.
 * Screenshots: apps/web/qa/out/stories/.
 */

const STORIES_DIR = path.join(OUT_DIR, "stories");
const STEP_TIMEOUT_MS = 30_000;
const SYNC_TIMEOUT_MS = 90_000;
const BACKUP_TIMEOUT_MS = 90_000;

/** The fake bank connected in stories 1 and 2: names come from `FakeEnableBanking` (Task 10). */
const FAKE_BANK = {
  name: "Banca Esempio",
  country: "IT",
  accounts: ["Conto Esempio", "Deposito Esempio"],
} as const;

/** A currency symbol next to digits: how an amount looks in the visible text. */
const AMOUNT = /(?:US\$|[€£$])\s?\d[\d.,]*|\d[\d.,]*\s?[€£$]/;
/** An English-format amount (`€1,234.56`) and an Italian-format number (`1.234,56`). */
const AMOUNT_EN = /[€$]\d{1,3}(?:,\d{3})*\.\d{2}/;
const NUMBER_IT = /\d\.\d{3},\d{2}/;
const MASK = "•••••";

/**
 * The labels the stories click or wait for. Stories 1 to 3 and 5 run with the panel in English
 * (`forceEnglish`); story 4 starts in Italian and uses this task's own Italian strings. The English
 * patterns come from Tasks 4 and 17 to 21; if one of those pages words a control differently,
 * change the pattern here and nowhere else.
 */
const UI = {
  connectBank: /connect a bank/i,
  continueTo: (bank: string) => new RegExp(`continue to ${bank}`, "i"),
  openAccounts: /open accounts/i,
  syncCompleted: /sync completed/i,
  renew: /renew/i,
  menu: /more|actions|menu/i,
  disconnectItem: /^disconnect/i,
  confirmDisconnect: /^yes, disconnect/i,
  disconnectedAccounts: /disconnected accounts/i,
  purge: /purge/i,
  confirmPurge: /^yes, purge/i,
  privacyOn: /privacy mode on/i,
  privacyOff: /privacy mode off/i,
} as const;

interface StoryContext {
  page: Page;
  context: BrowserContext;
  baseUrl: string;
  /** GET a JSON API path with the story's session. */
  get<T>(apiPath: string): Promise<T>;
  /** PATCH or POST JSON with the Origin header the server requires. */
  send<T>(method: "PATCH" | "POST", apiPath: string, data: unknown): Promise<T>;
  /** Full-page screenshot into apps/web/qa/out/stories/. */
  shot(name: string): Promise<void>;
}

interface Story {
  id: number;
  slug: string;
  title: string;
  run(ctx: StoryContext): Promise<void>;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Runs one named step; a failure keeps the step name so the report says where the story broke. */
async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${name}: ${errorMessage(error)}`);
  }
}

async function pollUntil(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(500);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

/** Waits until the text of `main` satisfies `predicate`; returns that text. */
async function waitForMain(
  page: Page,
  label: string,
  predicate: (text: string) => boolean,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await page.locator("main").first().innerText();
    if (predicate(text)) return text;
    await delay(250);
  }
  throw new Error(
    `timed out waiting for ${label}; main said: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
  );
}

function createStoryContext(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  slug: string,
): StoryContext {
  const call = async <T>(method: "GET" | "PATCH" | "POST", apiPath: string, data?: unknown) => {
    const response = await context.request.fetch(`${baseUrl}${apiPath}`, {
      method,
      data,
      headers: { origin: baseUrl },
    });
    if (!response.ok()) throw new Error(`${method} ${apiPath} answered ${response.status()}`);
    return (await response.json()) as T;
  };
  return {
    page,
    context,
    baseUrl,
    get: <T>(apiPath: string) => call<T>("GET", apiPath),
    send: <T>(method: "PATCH" | "POST", apiPath: string, data: unknown) =>
      call<T>(method, apiPath, data),
    async shot(name) {
      mkdirSync(STORIES_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(STORIES_DIR, `${slug}-${name}.png`),
        fullPage: true,
      });
    },
  };
}

/** English UI for the story: the saved locale and the browser's stored choice both say "en". */
async function forceEnglish(ctx: StoryContext): Promise<void> {
  await ctx.context.addInitScript(() => {
    try {
      globalThis.localStorage.setItem("bursar.language", "en");
    } catch {
      // Storage is unavailable: the saved locale applies once settings load.
    }
  });
  await ctx.send<SettingsResponse>("PATCH", "/api/settings", { locale: "en" });
}

const sidebarLink = (page: Page, name: RegExp): Locator =>
  page.getByRole("navigation").getByRole("link", { name }).first();

const linkOrButton = (page: Page, name: RegExp): Locator =>
  page.getByRole("link", { name }).or(page.getByRole("button", { name })).first();

/** Resolves true when a toast matching `text` shows up; never rejects, so it can run unattended. */
function watchToast(page: Page, text: RegExp): Promise<boolean> {
  return page
    .getByText(text)
    .first()
    .waitFor({ state: "visible", timeout: SYNC_TIMEOUT_MS })
    .then(
      () => true,
      () => false,
    );
}

/**
 * The smallest element that holds `text` and a button named `button`: a connection card (or its
 * header). Pick `text` and `button` so the match cannot be a single account row.
 */
function cardWith(page: Page, text: string, button: RegExp): Locator {
  return page
    .locator("div, section, article, li")
    .filter({ hasText: text })
    .filter({ has: page.getByRole("button", { name: button }) })
    .last();
}

/**
 * Accounts → Connect a bank → the wizard's consent step → the fake bank → the callback page.
 * The wizard keeps step, country and bank in the URL (Task 20), so the country and bank steps are
 * a URL jump; the consent button and everything after it are real clicks. Resolves with a watcher
 * for the "Sync completed" toast, started as soon as the callback has finished.
 */
async function connectBank(ctx: StoryContext): Promise<{ syncToast: Promise<boolean> }> {
  const { page } = ctx;
  await step("open Connect a bank from the Accounts page", async () => {
    await page.goto(`${ctx.baseUrl}/accounts`, { waitUntil: "load" });
    await linkOrButton(page, UI.connectBank).click();
    await page.waitForURL(/\/connect(\?|$)/);
  });
  await step("reach the consent step and continue to the bank", async () => {
    const bank = encodeURIComponent(FAKE_BANK.name);
    await page.goto(
      `${ctx.baseUrl}/connect?step=consent&country=${FAKE_BANK.country}&bank=${bank}`,
      { waitUntil: "load" },
    );
    await page.getByRole("button", { name: UI.continueTo(FAKE_BANK.name) }).click();
  });
  await step("come back from the fake bank to the callback page", async () => {
    await page.waitForURL(/\/connect\/callback/);
    await linkOrButton(page, UI.openAccounts).waitFor();
  });
  return { syncToast: watchToast(page, UI.syncCompleted) };
}

async function connectedAccounts(ctx: StoryContext): Promise<AccountSummary[]> {
  const { connections } = await ctx.get<ConnectionsResponse>("/api/connections");
  const names: readonly string[] = FAKE_BANK.accounts;
  return connections.flatMap((connection) =>
    connection.accounts.filter((account) => names.includes(account.name)),
  );
}

/** Waits until both accounts of the fake bank exist and hold transactions; returns them. */
async function waitForInitialSync(ctx: StoryContext): Promise<AccountSummary[]> {
  await pollUntil(
    "both accounts of the new connection to hold transactions",
    async () => {
      const accounts = await connectedAccounts(ctx);
      if (accounts.length !== FAKE_BANK.accounts.length) return false;
      const details = await Promise.all(
        accounts.map((account) => ctx.get<AccountDetailResponse>(`/api/accounts/${account.id}`)),
      );
      return details.every((detail) => detail.transactionCount > 0);
    },
    SYNC_TIMEOUT_MS,
  );
  return connectedAccounts(ctx);
}

/* -------------------------------------------------------------------------------------------- */

const connectSyncTransactions: Story = {
  id: 1,
  slug: "connect-sync-transactions",
  title: "Connect a bank, see its accounts, sync, read the transactions",
  async run(ctx) {
    const { page } = ctx;
    await forceEnglish(ctx);
    const { syncToast } = await connectBank(ctx);
    await step("the callback lists the accounts the bank returned", async () => {
      for (const name of FAKE_BANK.accounts) await page.getByText(name).first().waitFor();
    });
    await step("Open accounts leads to the Accounts page, which lists them", async () => {
      await linkOrButton(page, UI.openAccounts).click();
      await page.waitForURL(/\/accounts$/);
      for (const name of FAKE_BANK.accounts) await page.getByText(name).first().waitFor();
    });
    await step("the sync finishes with a toast and the accounts hold transactions", async () => {
      check(await syncToast, "no 'Sync completed' toast appeared");
      await waitForInitialSync(ctx);
    });
    await step("Transactions lists rows of the new accounts", async () => {
      await sidebarLink(page, /^Transactions/).click();
      await page.waitForURL(/\/transactions/);
      const rows = page
        .locator("tbody tr")
        .filter({ hasText: new RegExp(FAKE_BANK.accounts.join("|")) });
      await rows.first().waitFor();
      check((await rows.count()) > 0, "no transaction row shows one of the new accounts");
    });
    await ctx.shot("transactions");
  },
};

const renewConsent: Story = {
  id: 2,
  slug: "renew-consent",
  title: "Renew an expiring connection: the accounts keep their names and history",
  async run(ctx) {
    const { page } = ctx;
    await forceEnglish(ctx);
    // A 10-day consent makes the new connection "expiring" at once, so Renew is its primary action.
    await ctx.send("PATCH", "/api/settings", { consentDays: 10 });
    await connectBank(ctx);
    const before = await step("wait for the first sync, name one account", async () => {
      const accounts = await waitForInitialSync(ctx);
      const first = accounts[0];
      check(first !== undefined, "the connection has no accounts");
      await ctx.send("PATCH", `/api/accounts/${first.id}`, { nickname: "Household" });
      const detail = await ctx.get<AccountDetailResponse>(`/api/accounts/${first.id}`);
      check(
        detail.connection.status === "expiring",
        `expected an expiring connection, found ${detail.connection.status}`,
      );
      return Promise.all(
        accounts.map(async (account) => ({
          id: account.id,
          transactions: (await ctx.get<AccountDetailResponse>(`/api/accounts/${account.id}`))
            .transactionCount,
        })),
      );
    });
    await step("renew from the Accounts page and land on the callback", async () => {
      await ctx.send("PATCH", "/api/settings", { consentDays: 180 });
      await page.goto(`${ctx.baseUrl}/accounts`, { waitUntil: "load" });
      await page.getByText("Household").first().waitFor();
      await cardWith(page, "Household", UI.renew)
        .getByRole("button", { name: UI.renew })
        .first()
        .click();
      await page.waitForURL(/\/connect\/callback/);
      await linkOrButton(page, UI.openAccounts).waitFor();
    });
    await step("the same accounts keep their names and history", async () => {
      const { connections } = await ctx.get<ConnectionsResponse>("/api/connections");
      const first = before[0];
      check(first !== undefined, "no account was recorded before the renewal");
      const owner = connections.find((connection) =>
        connection.accounts.some((account) => account.id === first.id),
      );
      check(owner !== undefined, "the connection disappeared after the renewal");
      check(
        owner.accounts.length === before.length,
        `the connection now has ${owner.accounts.length} accounts`,
      );
      for (const old of before) {
        const account = owner.accounts.find((candidate) => candidate.id === old.id);
        check(account !== undefined, "an account was replaced instead of kept");
        const detail = await ctx.get<AccountDetailResponse>(`/api/accounts/${old.id}`);
        check(
          detail.transactionCount >= old.transactions,
          `history shrank from ${old.transactions} to ${detail.transactionCount} transactions`,
        );
      }
      check(
        owner.accounts.some((account) => account.id === first.id && account.name === "Household"),
        "the nickname was lost",
      );
      check(owner.status === "active", `expected an active connection, found ${owner.status}`);
      check(owner.renewedAt !== null, "the connection does not record the renewal");
    });
    await step("Accounts still shows the renamed account", async () => {
      await linkOrButton(page, UI.openAccounts).click();
      await page.waitForURL(/\/accounts$/);
      await page.getByText("Household").first().waitFor();
    });
    await ctx.shot("renewed");
  },
};

const disconnectAndPurge: Story = {
  id: 3,
  slug: "disconnect-purge",
  title: "Disconnect a bank, then purge its transactions",
  async run(ctx) {
    const { page } = ctx;
    await forceEnglish(ctx);
    // Seeded connection in error state (Task 6): "Polaris Finance" with the account "Compte Courant".
    const bank = "Polaris Finance";
    const account = "Compte Courant";
    await step("open Accounts and find the connection", async () => {
      await page.goto(`${ctx.baseUrl}/accounts`, { waitUntil: "load" });
      await page.getByText(account).first().waitFor();
    });
    await step("disconnect it from the connection menu and confirm", async () => {
      const card = cardWith(page, bank, UI.menu);
      await card.getByRole("button", { name: UI.menu }).first().click();
      await page
        .locator('[role="menuitem"], button')
        .filter({ hasText: UI.disconnectItem })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText(new RegExp(`disconnect ${bank}\\?`, "i")).waitFor();
      await dialog.getByRole("button", { name: UI.confirmDisconnect }).click();
      await dialog.waitFor({ state: "detached" });
    });
    await step("it moved to Disconnected accounts", async () => {
      await page.getByText(UI.disconnectedAccounts).first().waitFor();
      await pollUntil("the API to list the account as removed", async () => {
        const { connections, removedAccounts } =
          await ctx.get<ConnectionsResponse>("/api/connections");
        return (
          !connections.some((connection) => connection.bankName === bank) &&
          removedAccounts.some((removed) => removed.name === account)
        );
      });
    });
    await ctx.shot("disconnected");
    await step("purge its transactions and confirm", async () => {
      const row = page
        .locator("li, tr, div")
        .filter({ hasText: account })
        .filter({ has: page.getByRole("button", { name: UI.purge }) })
        .last();
      await row.getByRole("button", { name: UI.purge }).click();
      // The purge confirmation is an alertdialog (ConfirmDialog, Task 18).
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: UI.confirmPurge }).click();
      await dialog.waitFor({ state: "detached" });
    });
    await step("it disappears from the page and from the API", async () => {
      await pollUntil("the page to stop showing the account", async () => {
        return (await page.getByText(account).count()) === 0;
      });
      const { removedAccounts } = await ctx.get<ConnectionsResponse>("/api/connections");
      check(
        !removedAccounts.some((removed) => removed.name === account),
        "the purged account is still listed",
      );
      check(removedAccounts.length >= 1, "the other disconnected account was purged too");
    });
    await ctx.shot("purged");
  },
};

const switchLanguage: Story = {
  id: 4,
  slug: "switch-language",
  title: "Switch the language in Settings: the UI and the money preview follow",
  async run(ctx) {
    const { page } = ctx;
    const general = page.locator("#settings-general");
    await step("open Settings in Italian, the default language", async () => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "load" });
      await sidebarLink(page, /^Impostazioni/).click();
      await page.waitForURL(/\/settings/);
      await page.getByRole("heading", { level: 1, name: "Impostazioni" }).first().waitFor();
      check(NUMBER_IT.test(await general.innerText()), "the preview does not show Italian money");
    });
    await step("choose English: the preview follows before anything is saved", async () => {
      await general.getByRole("button", { name: "Modifica sezione Generale" }).click();
      await general.getByLabel("Lingua").selectOption("en");
      check(
        /€1,234\.56/.test(await general.innerText()),
        "the preview does not show English money",
      );
      await page.getByRole("region", { name: "Modifiche non salvate" }).waitFor();
    });
    await step("save: the whole UI switches to English", async () => {
      await general.getByRole("button", { name: "Salva sezione Generale" }).click();
      await page.getByRole("heading", { level: 1, name: "Settings" }).first().waitFor();
      await page.getByText("Settings saved").first().waitFor();
      check(
        (await page.evaluate(() => document.documentElement.lang)) === "en",
        "<html lang> did not change",
      );
      check(
        /€1,234\.56/.test(await general.innerText()),
        "the saved preview does not show English money",
      );
    });
    await step("money elsewhere follows: Accounts shows English formats", async () => {
      await sidebarLink(page, /^Accounts/).click();
      await page.waitForURL(/\/accounts$/);
      const text = await waitForMain(page, "English-format balances", (value) =>
        AMOUNT_EN.test(value),
      );
      check(!NUMBER_IT.test(text), "Italian-format money is still shown");
    });
    await step("the choice is stored: after a reload the UI is still English", async () => {
      await page.reload({ waitUntil: "load" });
      await sidebarLink(page, /^Transactions/).waitFor();
      const settings = await ctx.get<SettingsResponse>("/api/settings");
      check(settings.values.locale === "en", `the saved locale is ${settings.values.locale}`);
    });
    await ctx.shot("english");
    await step("the user menu switch is stored too: Italian survives a reload", async () => {
      await page.getByRole("button", { name: "Open the user menu" }).click();
      await page.getByRole("button", { name: "Italiano" }).click();
      await sidebarLink(page, /^Movimenti/).waitFor();
      await page.reload({ waitUntil: "load" });
      await sidebarLink(page, /^Movimenti/).waitFor();
      check(
        (await page.evaluate(() => document.documentElement.lang)) === "it",
        "<html lang> is not Italian after the reload",
      );
      const settings = await ctx.get<SettingsResponse>("/api/settings");
      check(settings.values.locale === "it", `the saved locale is ${settings.values.locale}`);
    });
  },
};

const privacyShortcut: Story = {
  id: 5,
  slug: "privacy-shortcut",
  title: "The privacy shortcut masks amounts on Home, Accounts and Transactions",
  async run(ctx) {
    const { page } = ctx;
    await forceEnglish(ctx);
    await step("Home shows amounts", async () => {
      await page.goto(`${ctx.baseUrl}/`, { waitUntil: "load" });
      await waitForMain(page, "amounts on Home", (text) => AMOUNT.test(text));
    });
    await step("Ctrl+Shift+H turns privacy mode on", async () => {
      await page.keyboard.press("Control+Shift+H");
      await page.getByText(UI.privacyOn).first().waitFor();
    });
    await step("Home masks every amount", async () => {
      await waitForMain(
        page,
        "masked amounts on Home",
        (text) => !AMOUNT.test(text) && text.includes(MASK),
      );
    });
    await step("Accounts masks every amount", async () => {
      await sidebarLink(page, /^Accounts/).click();
      await page.waitForURL(/\/accounts$/);
      await waitForMain(
        page,
        "masked balances",
        (text) => !AMOUNT.test(text) && text.includes(MASK),
      );
    });
    await step("Transactions masks every amount", async () => {
      await sidebarLink(page, /^Transactions/).click();
      await page.waitForURL(/\/transactions/);
      await page.locator("tbody tr").first().waitFor();
      await waitForMain(
        page,
        "masked transactions",
        (text) => !AMOUNT.test(text) && text.includes(MASK),
      );
    });
    await ctx.shot("masked");
    await step("the same shortcut shows them again", async () => {
      await page.keyboard.press("Control+Shift+H");
      await page.getByText(UI.privacyOff).first().waitFor();
      await waitForMain(page, "amounts after turning privacy off", (text) => AMOUNT.test(text));
    });
  },
};

const STORIES: readonly Story[] = [
  connectSyncTransactions,
  renewConsent,
  disconnectAndPurge,
  switchLanguage,
  privacyShortcut,
];

/* -------------------------------------------------------------------------------------------- */

/**
 * Screenshots the reviewer looks at (UX doc §9) and checks the pieces no story covers: the
 * Settings page with an unsaved edit, the live "Backup completed" toast, the notifications
 * popover with the seeded events and the `#backups` deep link. Each gallery is desktop light,
 * desktop dark and 390 px (which also fails on horizontal overflow).
 */
async function gallery(ctx: StoryContext, name: string): Promise<void> {
  const { page } = ctx;
  await ctx.shot(`${name}-desktop-light`);
  await page.emulateMedia({ colorScheme: "dark" });
  await delay(500);
  await ctx.shot(`${name}-desktop-dark`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await delay(500);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(overflow <= 1, `${name}: the page is ${overflow}px wider than the 390 px viewport`);
  await ctx.shot(`${name}-phone-light`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await delay(300);
}

async function reviewShots(ctx: StoryContext): Promise<void> {
  const { page } = ctx;
  await forceEnglish(ctx);
  await step("open Settings: five cards, one of them the #backups anchor", async () => {
    await page.goto(`${ctx.baseUrl}/settings`, { waitUntil: "load" });
    await page.getByRole("heading", { level: 1, name: "Settings" }).first().waitFor();
    // The cards render after the settings query resolves; the heading is there while they load.
    await page.locator("#settings-general").waitFor();
    for (const id of [
      "settings-general",
      "settings-banking",
      "settings-notifications",
      "settings-display",
      "backups",
    ]) {
      check((await page.locator(`#${id}`).count()) === 1, `the card #${id} is missing`);
    }
  });
  await step("an unsaved edit shows the sticky bar, then Discard clears it", async () => {
    await page.getByRole("button", { name: "Edit section Banking" }).click();
    await page.getByLabel("Consent length (days)").fill("90");
    await page.getByRole("region", { name: "Unsaved changes" }).waitFor();
    await gallery(ctx, "settings-unsaved");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await page.getByRole("region", { name: "Unsaved changes" }).waitFor({ state: "detached" });
  });
  await step("Back up now ends with the live 'Backup completed' toast and a new row", async () => {
    await page.getByRole("button", { name: "Back up now" }).click();
    await page.getByText("Backup completed").first().waitFor({ timeout: BACKUP_TIMEOUT_MS });
    await page.getByRole("cell", { name: "Manual" }).first().waitFor();
  });
  await step("the popover lists the seeded events with their parameters filled in", async () => {
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const popover = page.getByRole("dialog", { name: "Notifications" });
    await popover.getByText("Consent expiring").waitFor();
    const text = await popover.innerText();
    check(text.includes("Northwind Bank"), "the bank name is missing from the consent text");
    check(!text.includes("{{") && !/undefined/.test(text), "a placeholder is visible");
    check(!/see all/i.test(text), "the popover has a 'see all' footer");
    await gallery(ctx, "notifications-popover");
    await popover.getByRole("button", { name: /Consent expiring/ }).click();
    await page.waitForURL(/\/accounts$/);
    await pollUntil("the unread count to reach zero", async () => {
      const feed = await ctx.get<NotificationListResponse>("/api/notifications?limit=6");
      return feed.unread === 0;
    });
  });
  await step("the #backups link scrolls the card into view", async () => {
    await page.goto(`${ctx.baseUrl}/settings#backups`, { waitUntil: "load" });
    await page.locator("#backups").waitFor();
    await delay(800);
    const { scrolled, top, height } = await page.evaluate(() => ({
      scrolled: window.scrollY,
      top: document.getElementById("backups")?.getBoundingClientRect().top ?? -1,
      height: window.innerHeight,
    }));
    check(
      scrolled > 0 && top >= 0 && top < height - 100,
      `the card sits ${Math.round(top)} px down after scrolling ${Math.round(scrolled)} px`,
    );
    await gallery(ctx, "settings-backups");
  });
}

/* -------------------------------------------------------------------------------------------- */

/** A fresh QA server and browser context around `body`; returns the failures (empty when clean). */
async function inFreshApp(
  browser: Browser,
  slug: string,
  body: (ctx: StoryContext) => Promise<void>,
): Promise<string[]> {
  const failures: string[] = [];
  const server = await startQaServer({ owner: true });
  let context: BrowserContext | null = null;
  try {
    const token = server.sessionToken;
    check(token !== null, "the QA server returned no session token");
    const capture = CAPTURES[0];
    check(capture !== undefined, "the desktop-light capture is missing");
    context = await newCaptureContext(browser, capture, { baseUrl: server.baseUrl, token });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const probe = attachProbe(page);
    const ctx = createStoryContext(page, context, server.baseUrl, slug);
    try {
      await body(ctx);
    } catch (error) {
      failures.push(errorMessage(error));
      await ctx.shot("failure").catch(() => undefined);
    }
    failures.push(...probe.failures);
    if ((await page.locator("[data-error-boundary]").count()) > 0) {
      failures.push("boundary: an error boundary is rendered");
    }
  } catch (error) {
    failures.push(errorMessage(error));
  } finally {
    await context?.close().catch(() => undefined);
    await server.stop();
  }
  return failures;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "skip-build": { type: "boolean", default: false },
      only: { type: "string" },
    },
  });
  const only = values.only ? new Set(values.only.split(",").map((id) => Number(id.trim()))) : null;
  const selected = STORIES.filter((story) => only === null || only.has(story.id));
  if (selected.length === 0) throw new Error(`No story matches --only ${values.only ?? ""}`);
  if (values["skip-build"] !== true) buildWeb();

  const browser = await launchBrowser();
  let passed = 0;
  let failed = 0;
  let reviewFailures: string[] | null = null;
  try {
    for (const story of selected) {
      const started = Date.now();
      const failures = await inFreshApp(browser, `${story.id}-${story.slug}`, story.run);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (failures.length === 0) {
        passed += 1;
        console.log(`ok   ${story.id} ${story.title} (${seconds} s)`);
      } else {
        failed += 1;
        console.log(`FAIL ${story.id} ${story.title} (${seconds} s)`);
        for (const failure of [...new Set(failures)]) console.log(`       ${failure}`);
      }
    }
    if (only === null) reviewFailures = await inFreshApp(browser, "review", reviewShots);
  } finally {
    await browser.close();
  }

  console.log(`Stories: ${passed} passed, ${failed} failed`);
  if (reviewFailures !== null) {
    if (reviewFailures.length === 0) {
      console.log(`Review shots: ok (screenshots in ${path.relative(process.cwd(), STORIES_DIR)})`);
    } else {
      console.log("Review shots: FAILED");
      for (const failure of [...new Set(reviewFailures)]) console.log(`       ${failure}`);
    }
  }
  process.exitCode = failed > 0 || (reviewFailures?.length ?? 0) > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(`Stories failed to run: ${errorMessage(error)}`);
  process.exit(1);
});
