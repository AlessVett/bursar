import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import it_ from "../i18n/it.json";
import {
  breadcrumbTrail,
  buildPath,
  matchRoute,
  NAV_GROUPS,
  ROUTES,
  routeById,
  shippedRoutes,
} from "./routes";

const allShipped = ROUTES.map((def) => ({ ...def, shipped: true }));

function lookup(tree: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    return typeof node === "object" && node !== null
      ? (node as Record<string, unknown>)[part]
      : undefined;
  }, tree);
}

describe("route registry", () => {
  it("registers every M1–M4 page once, with Home as the only shipped route", () => {
    expect(ROUTES.map((def) => def.id)).toEqual([
      "home",
      "accounts",
      "account",
      "connect",
      "connectCallback",
      "transactions",
      "documents",
      "reports",
      "chat",
      "agents",
      "activity",
      "settings",
    ]);
    expect(shippedRoutes().map((def) => def.id)).toEqual(["home"]);
    expect(new Set(ROUTES.map((def) => def.path)).size).toBe(ROUTES.length);
  });

  it("places routes in the UX doc's navigation groups", () => {
    const groups = Object.fromEntries(ROUTES.map((def) => [def.id, def.group]));
    expect(groups).toEqual({
      home: "top",
      accounts: "money",
      account: null,
      connect: null,
      connectCallback: null,
      transactions: "money",
      documents: "knowledge",
      reports: "knowledge",
      chat: "agents",
      agents: "agents",
      activity: "agents",
      settings: "bottom",
    });
    for (const id of ["account", "connect", "connectCallback"] as const) {
      expect(routeById(id).parent).toBe("accounts");
    }
    expect(NAV_GROUPS).toEqual(["top", "money", "knowledge", "agents", "bottom"]);
  });

  it("has a title, description and keywords in both languages for every route", () => {
    for (const def of ROUTES) {
      for (const key of [def.titleKey, def.descriptionKey, def.keywordsKey]) {
        expect(typeof lookup(en, key), `en ${key}`).toBe("string");
        expect(typeof lookup(it_, key), `it ${key}`).toBe("string");
      }
    }
  });
});

describe("matchRoute", () => {
  it("prefers the route with the most fixed segments", () => {
    expect(matchRoute("/connect", allShipped)?.route.id).toBe("connect");
    expect(matchRoute("/connect/callback", allShipped)?.route.id).toBe("connectCallback");
    expect(matchRoute("/accounts", allShipped)?.route.id).toBe("accounts");
    expect(matchRoute("/", allShipped)?.route.id).toBe("home");
  });

  it("extracts and decodes parameters", () => {
    const match = matchRoute("/accounts/12", allShipped);
    expect(match?.route.id).toBe("account");
    expect(match?.params).toEqual({ accountId: "12" });
    expect(matchRoute("/accounts/a%20b/", allShipped)?.params).toEqual({ accountId: "a b" });
  });

  it("returns null for unknown paths, malformed escapes and unshipped routes by default", () => {
    expect(matchRoute("/nowhere", allShipped)).toBeNull();
    expect(matchRoute("/accounts/12/extra", allShipped)).toBeNull();
    expect(matchRoute("/accounts/%E0%A4%A", allShipped)).toBeNull();
    expect(matchRoute("/accounts")).toBeNull();
    expect(matchRoute("/connect/callback")).toBeNull();
    expect(matchRoute("/")?.route.id).toBe("home");
  });
});

describe("breadcrumbTrail", () => {
  it("lists the ancestors from the top down and ends with the route", () => {
    expect(breadcrumbTrail("account").map((def) => def.id)).toEqual(["accounts", "account"]);
    expect(breadcrumbTrail("connectCallback").map((def) => def.id)).toEqual([
      "accounts",
      "connectCallback",
    ]);
    expect(breadcrumbTrail("home").map((def) => def.id)).toEqual(["home"]);
  });
});

describe("buildPath", () => {
  it("fills parameters and leaves out empty search values", () => {
    expect(buildPath("home")).toBe("/");
    expect(buildPath("account", { accountId: 12 })).toBe("/accounts/12");
    expect(buildPath("transactions", {}, { tab: "in", q: "", from: "2026-11-01" })).toBe(
      "/transactions?tab=in&from=2026-11-01",
    );
    expect(buildPath("account", { accountId: "a/b" })).toBe("/accounts/a%2Fb");
  });

  it("throws when a parameter is missing", () => {
    expect(() => buildPath("account")).toThrow("Missing route parameter accountId");
  });
});
