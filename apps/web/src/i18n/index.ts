import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import it from "./it.json";

export const SUPPORTED_LANGUAGES = ["it", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = "bursar.language";

function readStoredLanguage(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Stored choice, then the browser language (`it*` or `en*`), then Italian. */
export function initialLanguage(): Language {
  const stored = readStoredLanguage();
  if (stored === "it" || stored === "en") return stored;
  const browser = globalThis.navigator?.language?.toLowerCase() ?? "";
  return browser.startsWith("en") ? "en" : "it";
}

function setDocumentLanguage(language: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

const language = initialLanguage();
setDocumentLanguage(language);
i18n.on("languageChanged", setDocumentLanguage);

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: language,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(language: Language): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, language);
  } catch {
    // Storage unavailable: the choice applies to this session only.
  }
  void i18n.changeLanguage(language);
}

export default i18n;
