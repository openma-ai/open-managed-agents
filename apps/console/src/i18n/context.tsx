import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Locale, Messages } from "./types";
import { en } from "./en";
import { zhCN } from "./zh-CN";

const dictionaries: Record<Locale, Messages> = {
  en,
  "zh-CN": zhCN,
};

const STORAGE_KEY = "oma-locale";

function getInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in dictionaries) return stored as Locale;
  // Browser language detection
  const lang = navigator.language;
  if (lang.startsWith("zh")) return "zh-CN";
  return "en";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
    // Update document lang attribute for accessibility and font rendering
    document.documentElement.lang = next;
  }, []);

  const t = useMemo(() => dictionaries[locale], [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

/**
 * Hook to access translations and locale controls.
 *
 * Usage:
 * ```tsx
 * const { t, locale, setLocale } = useI18n();
 * return <h1>{t.nav.dashboard}</h1>;
 * ```
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an <I18nProvider>");
  }
  return ctx;
}

/**
 * Available locales for the locale switcher UI.
 */
export const AVAILABLE_LOCALES: { value: Locale; label: string; flag: string }[] = [
  { value: "en", label: "English", flag: "EN" },
  { value: "zh-CN", label: "简体中文", flag: "中" },
];
