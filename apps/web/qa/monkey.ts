import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Page } from "playwright-core";
import {
  attachProbe,
  CAPTURES,
  errorMessage,
  newCaptureContext,
  type Session,
  settle,
} from "./lib";

/** Interactive elements the monkey clicks: buttons and in-app links inside the page and the topbar. */
const CLICKABLE = 'main button, main a[href^="/"], header button, header a[href^="/"]';
const MAX_CLICKS_PER_ROUTE = 40;
/** Never clicked: they end the session or destroy data that later routes need. */
const NEVER_CLICK = /^(sign out|log ?out|esci|disconnect|disconnetti|purge|elimina|delete)\b/i;
/** Never clicked inside a dialog: the confirming action of a confirmation. */
const CONFIRM_ACTION = /^(yes|sì|si|confirm|conferma|ok)\b/i;

export interface MonkeyTarget {
  /** Path and query of an authenticated route. */
  path: string;
  session: Session;
}

const currentPath = (page: Page): string => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};

/**
 * Clicks every visible, enabled button and in-app link on each route (desktop, light), pressing
 * Escape after each click and returning to the route when a click navigated away. Records page
 * errors, error boundaries and blank pages (an empty `main`). Returns failures per route path.
 */
export async function runMonkey(
  browser: Browser,
  targets: readonly MonkeyTarget[],
): Promise<Map<string, string[]>> {
  const capture = CAPTURES.find((candidate) => candidate.name === "desktop-light");
  if (!capture) throw new Error("The desktop-light capture is missing");
  const results = new Map<string, string[]>();
  for (const target of targets) {
    const context = await newCaptureContext(browser, capture, target.session);
    const failures: string[] = [];
    try {
      const page = await context.newPage();
      const probe = attachProbe(page);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        pageErrors.push(error.message);
      });
      const open = async (): Promise<string> => {
        await page.goto(`${target.session.baseUrl}${target.path}`, {
          waitUntil: "load",
          timeout: 30_000,
        });
        await settle(page, probe, []);
        return currentPath(page);
      };
      // URL state may drop default query values on load, so compare with the settled URL.
      const home = await open();
      let reload = false;
      const total = Math.min(MAX_CLICKS_PER_ROUTE, await page.locator(CLICKABLE).count());
      for (let index = 0; index < total; index += 1) {
        if (reload || currentPath(page) !== home) await open();
        reload = false;
        const element = page.locator(CLICKABLE).nth(index);
        if ((await element.count()) === 0) break;
        if (!(await element.isVisible()) || !(await element.isEnabled())) continue;
        const info = await element.evaluate((node) => {
          const el = node as HTMLElement;
          const label = (
            el.getAttribute("aria-label") ||
            // biome-ignore lint/performance/useDomNodeTextContent: the visible label is what a user reads
            el.innerText ||
            el.getAttribute("title") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);
          return {
            label,
            qaSkip: el.closest("[data-qa-skip]") !== null,
            newTab: el.getAttribute("target") === "_blank",
            inDialog: el.closest('[role="dialog"], [role="alertdialog"]') !== null,
          };
        });
        if (info.qaSkip || info.newTab || NEVER_CLICK.test(info.label)) continue;
        if (info.inDialog && CONFIRM_ACTION.test(info.label)) continue;
        const label = info.label || `#${index}`;
        pageErrors.length = 0;
        try {
          await element.click({ timeout: 2_000 });
        } catch {
          continue;
        }
        await probe.waitForQuiet(5_000);
        await delay(300);
        const state = await page.evaluate(() => {
          const main = document.querySelector("main");
          return {
            boundary: document.querySelector("[data-error-boundary]") !== null,
            // biome-ignore lint/performance/useDomNodeTextContent: blank means nothing visible
            blank: main === null || main.innerText.trim() === "",
          };
        });
        for (const message of pageErrors) {
          failures.push(`monkey: [${label}] pageerror: ${message.slice(0, 200)}`);
        }
        if (state.boundary) failures.push(`monkey: [${label}] error boundary`);
        if (state.blank) failures.push(`monkey: [${label}] blank page (empty main)`);
        reload = state.boundary || state.blank;
        await page.keyboard.press("Escape");
      }
    } catch (error) {
      failures.push(`monkey: ${target.path} could not be exercised: ${errorMessage(error)}`);
    } finally {
      await context.close();
    }
    results.set(target.path, failures);
  }
  return results;
}
