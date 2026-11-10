import {
  type AspspListResponse,
  type AspspSummary,
  aspspQuerySchema,
  type BankStatusResponse,
  logoQuerySchema,
} from "@bursar/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/app";
import type { AspspCache } from "./aspsp-cache";
import type { EnableBankingApi } from "./client";
import { EnableBankingError } from "./errors";
import { fetchLogo } from "./logo";
import type { EbApplication, EbAspsp } from "./schemas";

export const BANK_CALLBACK_PATH = "/api/banks/callback";
export const APPLICATION_CACHE_MS = 10 * 60_000;
const LOGO_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const SECONDS_PER_DAY = 86_400;

const NOT_FOUND = { error: "Not found" } as const;
const INVALID_REQUEST = { error: "Invalid request", code: "invalid_request" } as const;

function hasHttpsLogo(logo: string): boolean {
  try {
    return new URL(logo).protocol === "https:";
  } catch {
    return false;
  }
}

function sameUrl(candidate: string, expected: string): boolean {
  try {
    return new URL(candidate).href === expected;
  } catch {
    return false;
  }
}

function toSummary(aspsp: EbAspsp): AspspSummary {
  return {
    name: aspsp.name,
    country: aspsp.country,
    maximumConsentDays: Math.floor(aspsp.maximum_consent_validity / SECONDS_PER_DAY),
    beta: aspsp.beta,
    hasLogo: hasHttpsLogo(aspsp.logo),
  };
}

function statusErrorCode(error: EnableBankingError): string {
  if (error.code) return error.code;
  return error.status === 0 ? "unreachable" : `http_${error.status}`;
}

export function bankRoutes(deps: {
  api: EnableBankingApi | null;
  aspsps: AspspCache | null;
  publicUrl: URL;
  fetchLogo?: typeof fetch;
  now?: () => number;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const now = deps.now ?? Date.now;
  const logoFetch: typeof fetch =
    deps.fetchLogo ?? ((input, init) => globalThis.fetch(input, init));
  const callbackUrl = new URL(BANK_CALLBACK_PATH, deps.publicUrl).href;
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  let application: { fetchedAt: number; value: EbApplication } | null = null;

  router.get("/status", async (c) => {
    const api = deps.api;
    if (!api) {
      const body: BankStatusResponse = {
        configured: false,
        environment: null,
        active: null,
        redirectUrlAllowed: null,
        countries: [],
        error: null,
      };
      return c.json(body);
    }
    try {
      if (!application || now() - application.fetchedAt >= APPLICATION_CACHE_MS) {
        application = { fetchedAt: now(), value: await api.getApplication() };
      }
      const value = application.value;
      const body: BankStatusResponse = {
        configured: true,
        environment: value.environment,
        active: value.active,
        redirectUrlAllowed: value.redirect_urls.some((url) => sameUrl(url, callbackUrl)),
        countries: [...value.countries].sort(),
        error: null,
      };
      return c.json(body);
    } catch (error) {
      if (!(error instanceof EnableBankingError)) throw error;
      const body: BankStatusResponse = {
        configured: true,
        environment: null,
        active: null,
        redirectUrlAllowed: null,
        countries: [],
        error: statusErrorCode(error),
      };
      return c.json(body);
    }
  });

  router.get("/aspsps", async (c) => {
    const parsed = aspspQuerySchema.safeParse({ country: c.req.query("country") });
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    if (!deps.api || !deps.aspsps) {
      return c.json(
        { error: "Enable Banking is not configured", code: "banking_not_configured" },
        503,
      );
    }
    let list: EbAspsp[];
    try {
      list = await deps.aspsps.list(parsed.data.country);
    } catch (error) {
      if (!(error instanceof EnableBankingError)) throw error;
      return c.json({ error: "The bank list is unavailable", code: "bank_list_unavailable" }, 502);
    }
    const body: AspspListResponse = {
      aspsps: list.map(toSummary).sort((a, b) => collator.compare(a.name, b.name)),
    };
    return c.json(body);
  });

  router.get("/logo", async (c) => {
    const parsed = logoQuerySchema.safeParse({
      country: c.req.query("country"),
      name: c.req.query("name"),
    });
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    if (!deps.aspsps) return c.json(NOT_FOUND, 404);
    let aspsp: EbAspsp | null;
    try {
      aspsp = await deps.aspsps.find(parsed.data.country, parsed.data.name);
    } catch (error) {
      if (!(error instanceof EnableBankingError)) throw error;
      return c.json(NOT_FOUND, 404);
    }
    if (!aspsp || !hasHttpsLogo(aspsp.logo)) return c.json(NOT_FOUND, 404);
    const logo = await fetchLogo(aspsp.logo, logoFetch);
    if (!logo) return c.json(NOT_FOUND, 404);
    return c.body(new Uint8Array(logo.body), 200, {
      "Content-Type": logo.contentType,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": LOGO_CSP,
    });
  });

  return router;
}
