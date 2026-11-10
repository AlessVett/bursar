import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import type { Browser } from "playwright-core";
import { type RouteDef, shippedRoutes } from "../src/app/routes";
import { QA_EXTRA_PATHS } from "./extra-paths";
import {
  attachProbe,
  buildWeb,
  CAPTURES,
  type Capture,
  errorMessage,
  inspectPage,
  launchBrowser,
  newCaptureContext,
  OUT_DIR,
  type QaServer,
  type Session,
  slugify,
  startQaServer,
} from "./lib";
import { runMonkey } from "./monkey";
import { QA_PARAMS } from "./params";

class UsageError extends Error {}

interface Options {
  skipBuild: boolean;
  routes: string[] | null;
  monkey: boolean;
  selfTest: boolean;
}

interface Visit {
  /** Name in the report: the path, or the path plus the server it runs against. */
  label: string;
  path: string;
  server: QaServer;
  auth: boolean;
  expectPath: string;
  slug: string;
}

interface UrlReport {
  url: string;
  viewport: Capture["viewport"];
  theme: Capture["theme"];
  failures: string[];
  axeViolations: number;
}

interface AxeEntry {
  url: string;
  theme: Capture["theme"];
  rule: string;
  impact: string | null;
  nodes: number;
  help: string;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      "skip-build": { type: "boolean", default: false },
      routes: { type: "string" },
      monkey: { type: "boolean", default: false },
      "self-test": { type: "boolean", default: false },
    },
    strict: true,
  });
  const routes = values.routes
    ?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return {
    skipBuild: values["skip-build"] === true,
    routes: routes && routes.length > 0 ? routes : null,
    monkey: values.monkey === true,
    selfTest: values["self-test"] === true,
  };
}

function selectRoutes(options: Options): RouteDef[] {
  const shipped = shippedRoutes();
  const wanted = options.routes;
  if (!wanted) return shipped;
  const unknown = wanted.filter((id) => !shipped.some((route) => route.id === id));
  if (unknown.length > 0) {
    throw new UsageError(
      `Not a shipped route id: ${unknown.join(", ")} (shipped: ${shipped.map((r) => r.id).join(", ")})`,
    );
  }
  return shipped.filter((route) => wanted.includes(route.id));
}

function fillParams(route: RouteDef): string {
  return route.path.replace(/:[A-Za-z]+/g, (segment) => {
    const value = QA_PARAMS[segment];
    if (value === undefined) {
      throw new UsageError(
        `QA_PARAMS in qa/params.ts has no value for ${segment} (route ${route.id})`,
      );
    }
    return encodeURIComponent(value);
  });
}

function planVisits(
  routes: readonly RouteDef[],
  includeExtras: boolean,
  owner: QaServer,
  noOwner: QaServer,
): Visit[] {
  const visits: Visit[] = routes.map((route) => {
    const filled = fillParams(route);
    return {
      label: filled,
      path: filled,
      server: owner,
      auth: true,
      expectPath: filled,
      slug: slugify(filled),
    };
  });
  if (!includeExtras) return visits;
  for (const extra of QA_EXTRA_PATHS) {
    visits.push({
      label: extra.path,
      path: extra.path,
      server: owner,
      auth: extra.auth,
      expectPath: new URL(extra.path, owner.baseUrl).pathname,
      slug: `${extra.auth ? "" : "public-"}${slugify(extra.path)}`,
    });
  }
  visits.push(
    {
      label: "/login",
      path: "/login",
      server: owner,
      auth: false,
      expectPath: "/login",
      slug: "public-login",
    },
    {
      label: "/ (no owner)",
      path: "/",
      server: noOwner,
      auth: false,
      expectPath: "/setup",
      slug: "public-setup",
    },
  );
  return visits;
}

async function captureVisit(
  browser: Browser,
  visit: Visit,
  session: Session | null,
  reports: UrlReport[],
  axeEntries: AxeEntry[],
): Promise<number> {
  let screenshots = 0;
  for (const capture of CAPTURES) {
    const context = await newCaptureContext(browser, capture, session);
    try {
      const page = await context.newPage();
      const probe = attachProbe(page);
      const result = await inspectPage(page, probe, {
        url: `${visit.server.baseUrl}${visit.path}`,
        capture,
        expectPath: visit.expectPath,
        checkTheme: true,
        screenshotPath: path.join(OUT_DIR, visit.slug, `${capture.name}.png`),
      });
      if (result.screenshotTaken) screenshots += 1;
      let axeViolations = 0;
      if (capture.viewport === "desktop" && result.screenshotTaken) {
        try {
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
          axeViolations = axe.violations.length;
          for (const violation of axe.violations) {
            axeEntries.push({
              url: visit.label,
              theme: capture.theme,
              rule: violation.id,
              impact: violation.impact ?? null,
              nodes: violation.nodes.length,
              help: violation.help,
            });
          }
        } catch (error) {
          console.warn(
            `axe could not run on ${visit.label} (${capture.name}): ${errorMessage(error)}`,
          );
        }
      }
      reports.push({
        url: visit.label,
        viewport: capture.viewport,
        theme: capture.theme,
        failures: result.failures,
        axeViolations,
      });
    } finally {
      await context.close();
    }
  }
  return screenshots;
}

async function runQa(
  browser: Browser,
  options: Options,
  routes: readonly RouteDef[],
  owner: QaServer,
  noOwner: QaServer,
): Promise<number> {
  const token = owner.sessionToken;
  if (!token) throw new Error("The owner QA server returned no session token");
  const session: Session = { baseUrl: owner.baseUrl, token };
  const visits = planVisits(routes, options.routes === null, owner, noOwner);
  const startedAt = new Date().toISOString();
  const reports: UrlReport[] = [];
  const axeEntries: AxeEntry[] = [];
  let screenshots = 0;

  for (const visit of visits) {
    const before = reports.length;
    screenshots += await captureVisit(
      browser,
      visit,
      visit.auth ? session : null,
      reports,
      axeEntries,
    );
    const found = reports.slice(before).reduce((sum, entry) => sum + entry.failures.length, 0);
    console.log(`${found === 0 ? "ok  " : "FAIL"} ${visit.label}`);
  }

  if (options.monkey) {
    const targets = visits
      .filter((visit) => visit.auth)
      .map((visit) => ({ path: visit.path, session }));
    const monkey = await runMonkey(browser, targets);
    for (const visit of visits.filter((candidate) => candidate.auth)) {
      const entry = reports.find(
        (report) =>
          report.url === visit.label && report.viewport === "desktop" && report.theme === "light",
      );
      const found = monkey.get(visit.path) ?? [];
      if (entry) entry.failures.push(...found);
      console.log(`${found.length === 0 ? "ok  " : "FAIL"} monkey ${visit.label}`);
    }
  }

  const failures = reports.reduce((sum, entry) => sum + entry.failures.length, 0);
  writeFileSync(
    path.join(OUT_DIR, "report.json"),
    `${JSON.stringify({ startedAt, urls: reports, failures }, null, 2)}\n`,
  );
  writeFileSync(path.join(OUT_DIR, "axe.json"), `${JSON.stringify(axeEntries, null, 2)}\n`);

  for (const entry of reports) {
    if (entry.failures.length === 0) continue;
    console.log(`\n${entry.url} [${entry.viewport}-${entry.theme}]`);
    for (const failure of entry.failures) console.log(`  - ${failure}`);
  }
  const relativeOut = path.relative(process.cwd(), OUT_DIR) || ".";
  console.log(
    `\naxe (report only): ${axeEntries.length} violations, details in ${relativeOut}/axe.json`,
  );
  console.log(`Screenshots: ${relativeOut}`);
  console.log(`QA: ${visits.length} urls, ${screenshots} screenshots, ${failures} failures`);
  return failures > 0 ? 1 : 0;
}

/** The eight checks the self-test proves; each has one deliberate fault in the fixture. */
const SELF_TEST_CHECKS = [
  "console",
  "pageerror",
  "csp",
  "overflow",
  "text",
  "i18n",
  "api5xx",
  "boundary",
] as const;

const FAULTY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QA self-test</title>
    <style>body { outline: 1px solid red; }</style>
  </head>
  <body>
    <main>
      <h1>QA self-test</h1>
      <p>Total: NaN</p>
      <p>common.qaSelfTestKey</p>
      <div id="qa-wide"></div>
      <div data-error-boundary>Something went wrong</div>
    </main>
    <script src="/__qa_self_test.js"></script>
  </body>
</html>`;

const FAULTY_JS = `console.error("QA self-test: deliberate console error");
const wide = document.getElementById("qa-wide");
if (wide) { wide.style.width = "2000px"; wide.style.height = "8px"; }
void fetch("/api/__qa_self_test");
setTimeout(() => { throw new Error("QA self-test: deliberate page error"); }, 0);
`;

const CLEAN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QA self-test (clean)</title>
  </head>
  <body>
    <main><h1>QA self-test</h1><p>Everything on this page is fine.</p></main>
  </body>
</html>`;

/**
 * Serves fixture pages under the QA server's origin with its real CSP header and checks that
 * every check fires on the faulty page and none fires on the clean page.
 */
async function runSelfTest(browser: Browser, server: QaServer): Promise<number> {
  const live = await fetch(`${server.baseUrl}/login`);
  const csp = live.headers.get("content-security-policy");
  if (!csp) throw new Error("The QA server sent no content-security-policy header");
  const phone = CAPTURES.find((capture) => capture.viewport === "phone");
  if (!phone) throw new Error("The phone capture is missing");

  const context = await newCaptureContext(browser, phone, null);
  try {
    const page = await context.newPage();
    const html = (body: string) => ({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": csp },
      body,
    });
    await page.route(
      (url) => url.pathname === "/__qa_self_test",
      (route) => route.fulfill(html(FAULTY_HTML)),
    );
    await page.route(
      (url) => url.pathname === "/__qa_self_test.js",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          body: FAULTY_JS,
        }),
    );
    await page.route(
      (url) => url.pathname === "/api/__qa_self_test",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"error":"Internal error"}',
        }),
    );
    await page.route(
      (url) => url.pathname === "/__qa_self_test_clean",
      (route) => route.fulfill(html(CLEAN_HTML)),
    );
    const probe = attachProbe(page);
    const faulty = await inspectPage(page, probe, {
      url: `${server.baseUrl}/__qa_self_test`,
      capture: phone,
      expectPath: null,
      checkTheme: false,
      screenshotPath: null,
    });
    const clean = await inspectPage(page, probe, {
      url: `${server.baseUrl}/__qa_self_test_clean`,
      capture: phone,
      expectPath: null,
      checkTheme: false,
      screenshotPath: null,
    });

    let missed = 0;
    for (const check of SELF_TEST_CHECKS) {
      const hit = faulty.failures.some((failure) => failure.startsWith(`${check}:`));
      if (!hit) missed += 1;
      console.log(`${hit ? "detected" : "MISSED  "} ${check}`);
    }
    for (const failure of clean.failures) console.log(`unexpected on the clean page: ${failure}`);
    console.log(
      `QA self-test: ${SELF_TEST_CHECKS.length - missed}/${SELF_TEST_CHECKS.length} checks detected, clean page ${clean.failures.length} failures`,
    );
    return missed === 0 && clean.failures.length === 0 ? 0 : 1;
  } finally {
    await context.close();
  }
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const routes = selectRoutes(options);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  if (!options.skipBuild) buildWeb();

  const browser = await launchBrowser();
  const servers: QaServer[] = [];
  try {
    const owner = await startQaServer({ owner: true });
    servers.push(owner);
    if (options.selfTest) return await runSelfTest(browser, owner);
    const noOwner = await startQaServer({ owner: false });
    servers.push(noOwner);
    return await runQa(browser, options, routes, owner, noOwner);
  } finally {
    await browser.close();
    await Promise.all(servers.map((server) => server.stop()));
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof UsageError ? error.message : error);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
