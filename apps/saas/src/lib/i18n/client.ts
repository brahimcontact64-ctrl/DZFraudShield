"use client";

import { useMemo } from "react";
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/config";
import { getDictionary, translate } from "@/lib/i18n/dictionaries";

export function getClientLocale(): SupportedLocale {
  if (typeof document !== "undefined") {
    const htmlLang = document.documentElement.lang;
    if (isSupportedLocale(htmlLang)) {
      return htmlLang;
    }
  }

  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem("dzfs_locale");
    if (isSupportedLocale(stored)) {
      return stored;
    }
  }

  return DEFAULT_LOCALE;
}

export function useI18n() {
  const locale = getClientLocale();

  return useMemo(() => {
    const localeDict = getDictionary(locale);
    const fallback = getDictionary("en");

    return {
      locale,
      dir: locale === "ar" ? "rtl" as const : "ltr" as const,
      t: (key: string, params?: Record<string, string | number>) => translate(localeDict, fallback, key, params),
    };
  }, [locale]);
}
