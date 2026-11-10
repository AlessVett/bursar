import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Request as PwRequest,
} from "playwright-core";

declare global {
  interface Window {
    /** CSP violations recorded by the QA init script. */
    __qaCsp?: string[];
  }
}

export const WEB_DIR = path.resolve(import.meta.dirname, "..");
export const SERVER_DIR = path.resolve(WEB_DIR, "../server");
export const WEB_DIST = path.join(WEB_DIR, "dist");
export const OUT_DIR = path.join(WEB_DIR, "qa", "out");

export type CaptureName = "desktop-light" | "desktop-dark" | "phone-light";

export interface Capture {
  name: CaptureName;
  viewport: "desktop" | "phone";
  theme: "light" | "dark";
  width: number;
  height: number;
}

/** UX doc §9: every route at 1440×900 light and dark, and at 390×844. */
export const CAPTURES: readonly Capture[] = [
  { name: "desktop-light", viewport: "desktop", theme: "light", width: 1440, height: 900 },
  { name: "desktop-dark", viewport: "desktop", theme: "dark", width: 1440, height: 900 },
  { name: "phone-light", viewport: "phone", theme: "light", width: 390, height: 844 },
];

/** The panel's default language and the QA server's time zone. */
const QA_LOCALE = "it-IT";
const QA_TIMEZONE = "Europe/Rome";

/** Pause after the page is quiet, so entry animations (≤ 530 ms) finish before the checks. */
const SETTLE_MS = 700;

/** Event streams stay open by design and never count as pending network work. */
const STREAM_PATHS = new Set(["/api/events"]);

/** Visible text that reveals a formatting bug. */
const BAD_VALUE_PATTERN = /\bundefined\b|\bNaN\b|Invalid Date/g;

/** Visible text that looks like an untranslated i18n key of a known prefix. */
const RAW_KEY_PATTERN =
  /\b(common|nav|shell|home|accounts|account|connect|transactions|settings|notifications|routes|empty|table|errors)\.[A-Za-z0-9_.]+\b/g;

const OS_DEFAULT_CHROME: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const clip = (text: string, max = 300): string => text.replace(/\s+/g, " ").trim().slice(0, max);

const unique = (matches: RegExpMatchArray | null): string[] => [...new Set(matches ?? [])];

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** "/" → "root", "/accounts/1?tab=connection" → "accounts-1-tab-connection". */
export function slugify(urlPath: string): string {
  const slug = urlPath
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "root";
}

/** The system Chrome: CHROME_PATH, else the OS default location, else Playwright's "chrome" channel. Never downloads a browser. */
export async function launchBrowser(): Promise<Browser> {
  const configured = process.env.CHROME_PATH;
  if (configured) {
    if (!existsSync(configured))
      throw new Error(`CHROME_PATH points to a missing file: ${configured}`);
    return chromium.launch({ executablePath: configured, headless: true });
  }
  const osDefault = OS_DEFAULT_CHROME[process.platform];
  if (osDefault && existsSync(osDefault)) {
    return chromium.launch({ executablePath: osDefault, headless: true });
  }
  return chromium.launch({ channel: "chrome", headless: true });
}

/** Production build of the panel into apps/web/dist. */
export function buildWeb(): void {
  const result = spawnSync("pnpm", ["run", "build"], { cwd: WEB_DIR, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`The web build failed (exit ${result.status ?? result.signal ?? "unknown"})`);
  }
}

export interface QaServer {
  baseUrl: string;
  sessionToken: string | null;
  stop(): Promise<void>;
}

interface ReadyLine {
  ready: true;
  baseUrl: string;
  sessionToken: string | null;
}

function parseReadyLine(line: string): ReadyLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const token = record.sessionToken;
  if (record.ready !== true || typeof record.baseUrl !== "string") return null;
  if (typeof token !== "string" && token !== null) return null;
  return { ready: true, baseUrl: record.baseUrl, sessionToken: token };
}

const liveServers = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of liveServers) child.kill("SIGTERM");
});

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<ReadyLine> {
  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error("The QA server has no stdout pipe"));
  return new Promise((resolve, reject) => {
    // The two callbacks reference each other; both run only after both constants exist.
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`The QA server was not ready within ${timeoutMs} ms`));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`The QA server exited before it was ready (exit ${code ?? "signal"})`));
    };
    child.once("exit", onExit);
    // Keeps reading after the ready line so the pipe never fills up.
    createInterface({ input: stdout }).on("line", (line) => {
      const ready = parseReadyLine(line);
      if (!ready) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(ready);
    });
  });
}

/** Starts apps/server/src/qa/qa-server.ts and waits for its ready line. */
export async function startQaServer(options: {
  owner: boolean;
  webDist?: string;
}): Promise<QaServer> {
  const tsx = path.join(SERVER_DIR, "node_modules", ".bin", "tsx");
  const args = [
    "--tsconfig",
    "tsconfig.runtime.json",
    "src/qa/qa-server.ts",
    "--web-dist",
    options.webDist ?? WEB_DIST,
  ];
  if (!options.owner) args.push("--no-owner");
  const child = spawn(tsx, args, { cwd: SERVER_DIR, stdio: ["pipe", "pipe", "inherit"] });
  liveServers.add(child);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      liveServers.delete(child);
      resolve();
    });
  });
  const ready = await waitForReady(child, 60_000).catch(async (error: unknown) => {
    child.kill("SIGKILL");
    await exited;
    throw error;
  });
  return {
    baseUrl: ready.baseUrl,
    sessionToken: ready.sessionToken,
    async stop() {
      if (!liveServers.has(child)) return;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(force);
    },
  };
}

export interface Session {
  baseUrl: string;
  token: string;
}

/**
 * A fresh browser context for one capture: viewport, colour scheme (the panel's theme
 * preference stays at its default "system"), Italian locale, Rome time zone, a CSP violation
 * recorder, and the owner's session cookie when `session` is given.
 */
export async function newCaptureContext(
  browser: Browser,
  capture: Capture,
  session: Session | null,
): Promise<BrowserContext> {
  const phone = capture.viewport === "phone";
  const context = await browser.newContext({
    viewport: { width: capture.width, height: capture.height },
    colorScheme: capture.theme,
    locale: QA_LOCALE,
    timezoneId: QA_TIMEZONE,
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
  });
  await context.addInitScript(() => {
    window.__qaCsp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__qaCsp?.push(
        `${event.effectiveDirective} blocked ${event.blockedURI || "inline"} (${event.sourceFile || "document"}:${event.lineNumber})`,
      );
    });
  });
  if (session) {
    await context.addCookies([
      {
        name: "bursar_session",
        value: session.token,
        url: session.baseUrl,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
  }
  return context;
}

export interface Probe {
  readonly failures: string[];
  reset(): void;
  waitForQuiet(timeoutMs?: number): Promise<void>;
}

/**
 * Console resource errors for the API are page states (4xx) or already reported as api5xx;
 * a missing favicon is noise. Every other failed resource is a console failure.
 */
function isReportedElsewhere(text: string, url: string): boolean {
  if (!text.startsWith("Failed to load resource")) return false;
  const pathname = pathOf(url);
  return pathname === "/favicon.ico" || pathname.startsWith("/api/");
}

/** Listens to a page for console errors, page errors, CSP console reports, API 5xx and pending requests. */
export function attachProbe(page: Page): Probe {
  const failures: string[] = [];
  const pending = new Set<PwRequest>();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Content Security Policy/i.test(text)) failures.push(`csp: ${clip(text)}`);
    else if (!isReportedElsewhere(text, message.location().url))
      failures.push(`console: ${clip(text)}`);
  });
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${clip(error.message)}`);
  });
  page.on("response", (response) => {
    const pathname = pathOf(response.url());
    if (pathname.startsWith("/api/") && response.status() >= 500) {
      failures.push(`api5xx: ${response.request().method()} ${pathname} -> ${response.status()}`);
    }
  });
  page.on("request", (request) => {
    if (request.resourceType() === "eventsource" || STREAM_PATHS.has(pathOf(request.url()))) return;
    pending.add(request);
  });
  const done = (request: PwRequest) => {
    pending.delete(request);
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    failures,
    reset: () => {
      failures.length = 0;
    },
    async waitForQuiet(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let quietSince: number | null = null;
      while (Date.now() < deadline) {
        if (pending.size === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= 500) return;
        } else {
          quietSince = null;
        }
        await delay(50);
      }
      const waiting = [...pending].map((request) => pathOf(request.url())).slice(0, 3);
      failures.push(`network: still waiting for ${waiting.join(", ")} after ${timeoutMs} ms`);
    },
  };
}

/** Waits for a quiet network, no aria-busy element, loaded fonts and finished entry animations. */
export async function settle(page: Page, probe: Probe, failures: string[]): Promise<void> {
  await probe.waitForQuiet();
  try {
    await page.waitForFunction(
      () => document.querySelector('[aria-busy="true"]') === null,
      undefined,
      { timeout: 10_000 },
    );
  } catch {
    failures.push('busy: an element is still aria-busy="true" after 10 s');
  }
  try {
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  } catch (error) {
    failures.push(`navigation: ${clip(errorMessage(error))}`);
  }
  await delay(SETTLE_MS);
}

export interface InspectTarget {
  /** Absolute URL to open. */
  url: string;
  capture: Capture;
  /** Pathname the page must end on (a redirect elsewhere is a failure); null skips the check. */
  expectPath: string | null;
  /** Require `<html data-theme>` to match the capture's theme. */
  checkTheme: boolean;
  /** Full-page screenshot destination; null takes none. */
  screenshotPath: string | null;
}

/** Opens a URL in a page that already has a probe attached, runs every check and takes the screenshot. */
export async function inspectPage(
  page: Page,
  probe: Probe,
  target: InspectTarget,
): Promise<{ failures: string[]; screenshotTaken: boolean }> {
  probe.reset();
  const failures: string[] = [];
  try {
    await page.goto(target.url, { waitUntil: "load", timeout: 30_000 });
  } catch (error) {
    return { failures: [`navigation: ${clip(errorMessage(error))}`], screenshotTaken: false };
  }
  await settle(page, probe, failures);

  const facts = await page.evaluate(() => {
    const root = document.documentElement;
    const width = Math.min(window.innerWidth, root.clientWidth);
    const offenders: string[] = [];
    if (root.scrollWidth > width + 1) {
      for (const element of Array.from(document.body.querySelectorAll("*"))) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.right <= width + 1) continue;
        const parent = element.parentElement?.getBoundingClientRect();
        if (parent && parent.right > width + 1 && Math.abs(parent.right - rect.right) <= 4)
          continue;
        const classes = (element.getAttribute("class") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 4)
          .join(".");
        offenders.push(
          `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""} right=${Math.round(rect.right)}`,
        );
        if (offenders.length === 3) break;
      }
    }
    return {
      pathname: window.location.pathname,
      // biome-ignore lint/performance/useDomNodeTextContent: the rendered (visible) text is what the QA checks
      text: document.body.innerText,
      scrollWidth: root.scrollWidth,
      width,
      offenders,
      boundary: document.querySelector("[data-error-boundary]") !== null,
      theme: root.dataset.theme ?? null,
      csp: window.__qaCsp ?? [],
    };
  });

  if (target.capture.viewport === "phone" && facts.scrollWidth > facts.width + 1) {
    failures.push(
      `overflow: page is ${facts.scrollWidth}px wide at ${facts.width}px; widest: ${facts.offenders.join("; ") || "unknown"}`,
    );
  }
  const badValues = unique(facts.text.match(BAD_VALUE_PATTERN));
  if (badValues.length > 0) failures.push(`text: ${badValues.join(", ")}`);
  const rawKeys = unique(facts.text.match(RAW_KEY_PATTERN));
  if (rawKeys.length > 0) failures.push(`i18n: raw keys ${rawKeys.slice(0, 5).join(", ")}`);
  if (facts.boundary) failures.push("boundary: an error boundary is rendered");
  for (const violation of facts.csp) failures.push(`csp: ${violation}`);
  if (target.expectPath !== null && facts.pathname !== target.expectPath) {
    failures.push(`redirect: expected ${target.expectPath}, landed on ${facts.pathname}`);
  }
  if (target.checkTheme && facts.theme !== target.capture.theme) {
    failures.push(
      `theme: expected data-theme="${target.capture.theme}", found ${facts.theme ?? "none"}`,
    );
  }

  let screenshotTaken = false;
  if (target.screenshotPath) {
    mkdirSync(path.dirname(target.screenshotPath), { recursive: true });
    await page.screenshot({ path: target.screenshotPath, fullPage: true });
    screenshotTaken = true;
  }
  return { failures: [...new Set([...probe.failures, ...failures])], screenshotTaken };
}
