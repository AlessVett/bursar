import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import english from "./en.json";
import i18n, { initialLanguage } from "./index";
import italian from "./it.json";

type Resource = Record<string, unknown>;

function flatten(value: object, prefix = ""): Record<string, unknown> {
  return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, child]) => {
    if (typeof child === "object" && child !== null)
      Object.assign(acc, flatten(child, `${prefix}${key}.`));
    else acc[`${prefix}${key}`] = child;
    return acc;
  }, {});
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** `accounts.count_one` and `accounts.count_other` are both forms of `accounts.count`. */
function pluralBase(key: string): string {
  return key.replace(PLURAL_SUFFIX, "");
}

function baseKeys(resource: Resource): string[] {
  return [...new Set(Object.keys(flatten(resource)).map(pluralBase))].sort();
}

/** Every plural base needs `_one`, `_other` and any other category the language uses. */
function pluralProblems(resource: Resource, locale: string): string[] {
  const forms = new Map<string, Set<string>>();
  for (const key of Object.keys(flatten(resource))) {
    const match = PLURAL_SUFFIX.exec(key);
    if (!match) continue;
    const base = pluralBase(key);
    const suffixes = forms.get(base) ?? new Set<string>();
    suffixes.add(match[1] ?? "");
    forms.set(base, suffixes);
  }
  const required = new Set([
    "one",
    "other",
    ...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
  ]);
  const problems: string[] = [];
  for (const [base, suffixes] of forms) {
    for (const category of required) {
      if (!suffixes.has(category)) problems.push(`${base}_${category}`);
    }
  }
  return problems.sort();
}

describe("translations", () => {
  it("define the same keys in Italian and English, ignoring plural suffixes", () => {
    expect(baseKeys(italian)).toEqual(baseKeys(english));
  });

  it("contain no empty strings", () => {
    for (const value of [...Object.values(flatten(italian)), ...Object.values(flatten(english))]) {
      expect(typeof value === "string" && value.trim().length > 0).toBe(true);
    }
  });

  it("give every plural key all the forms its language needs", () => {
    expect(pluralProblems(italian, "it")).toEqual([]);
    expect(pluralProblems(english, "en")).toEqual([]);
  });
});

describe("plural checks", () => {
  it("accept complete forms and flag missing ones", () => {
    const complete = { n_one: "a", n_many: "b", n_other: "c", plain: "d" };
    expect(pluralProblems(complete, "it")).toEqual([]);
    expect(pluralProblems({ n_one: "a", n_other: "c" }, "en")).toEqual([]);
    expect(pluralProblems({ group: { n_one: "a" } }, "en")).toEqual(["group.n_other"]);
    expect(pluralProblems({ n_one: "a", n_other: "c" }, "it")).toEqual(["n_many"]);
  });

  it("compare bases, not suffixes", () => {
    expect(baseKeys({ n_one: "a", n_many: "b", n_other: "c" })).toEqual(["n"]);
    expect(baseKeys({ n_one: "a", n_other: "c" })).toEqual(["n"]);
  });
});

describe("Italian plural category many", () => {
  async function translator(italianResource: Resource) {
    const instance = i18next.createInstance();
    await instance.init({
      lng: "it",
      fallbackLng: "en",
      resources: {
        it: { translation: italianResource },
        en: { translation: { n_one: "{{count}} thing", n_other: "{{count}} things" } },
      },
      interpolation: { escapeValue: false },
      initAsync: false,
    });
    return instance;
  }

  it("is selected by Intl.PluralRules for exact millions", () => {
    expect(new Intl.PluralRules("it").select(1_000_000)).toBe("many");
    expect(new Intl.PluralRules("it").select(2)).toBe("other");
    expect(new Intl.PluralRules("en").select(1_000_000)).toBe("other");
  });

  it("uses the _many key when it exists", async () => {
    const t = (
      await translator({
        n_one: "{{count}} cosa",
        n_many: "{{count}} di cose",
        n_other: "{{count}} cose",
      })
    ).t;
    expect(t("n", { count: 1 })).toBe("1 cosa");
    expect(t("n", { count: 2 })).toBe("2 cose");
    expect(t("n", { count: 1_000_000 })).toBe("1000000 di cose");
  });

  it("does not fall back to _other: without _many the English fallback language answers", async () => {
    const t = (await translator({ n_one: "{{count}} cosa", n_other: "{{count}} cose" })).t;
    expect(t("n", { count: 1_000_000 })).toBe("1000000 things");
  });
});

describe("initialLanguage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.localStorage.clear();
  });

  function browserLanguage(language: string) {
    vi.spyOn(globalThis.navigator, "language", "get").mockReturnValue(language);
  }

  it("prefers the stored language", () => {
    browserLanguage("en-GB");
    globalThis.localStorage.setItem("bursar.language", "it");
    expect(initialLanguage()).toBe("it");
  });

  it("follows an English or Italian browser", () => {
    browserLanguage("en-GB");
    expect(initialLanguage()).toBe("en");
    browserLanguage("it-IT");
    expect(initialLanguage()).toBe("it");
  });

  it("defaults to Italian for any other browser language or a bad stored value", () => {
    browserLanguage("de-DE");
    expect(initialLanguage()).toBe("it");
    globalThis.localStorage.setItem("bursar.language", "fr");
    expect(initialLanguage()).toBe("it");
  });

  it("survives a throwing localStorage", () => {
    browserLanguage("en-US");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(initialLanguage()).toBe("en");
  });
});

describe("document language", () => {
  it("follows the active language", async () => {
    await i18n.changeLanguage("it");
    expect(document.documentElement.lang).toBe("it");
    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
