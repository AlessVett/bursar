import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import it from "./it.json";

export const SUPPORTED_LANGUAGES = ["it", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = "bursar.language";

function initialLanguage(): Language {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (stored === "it" || stored === "en") return stored;
  return globalThis.navigator?.language?.toLowerCase().startsWith("it") ? "it" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(language: Language): void {
  globalThis.localStorage?.setItem(STORAGE_KEY, language);
  document.documentElement.lang = language;
  void i18n.changeLanguage(language);
}

export default i18n;
