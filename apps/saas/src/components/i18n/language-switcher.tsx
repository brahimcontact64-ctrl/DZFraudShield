"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/client";

const languageLabels: Record<SupportedLocale, string> = {
  ar: "العربية",
  fr: "Français",
  en: "English",
};

export function LanguageSwitcher() {
  const router = useRouter();
  const { locale, t } = useI18n();

  const value = useMemo(() => (SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE), [locale]);

  function setLocale(nextLocale: SupportedLocale) {
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `${LOCALE_COOKIE_NAME}=${nextLocale}; path=/; max-age=${maxAge}; samesite=lax`;
    window.localStorage.setItem("dzfs_locale", nextLocale);

    document.documentElement.lang = nextLocale;
    document.documentElement.dir = nextLocale === "ar" ? "rtl" : "ltr";

    fetch("/api/v1/merchant/notification-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredLanguage: nextLocale }),
      cache: "no-store",
    }).catch(() => {
      // Locale switch should still work even if settings persistence fails.
    });

    router.refresh();
  }

  return (
    <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">
      <span className="hidden sm:inline">{t("language.label")}</span>
      <select
        aria-label={t("language.label")}
        className="bg-transparent font-semibold text-slate-700 outline-none"
        value={value}
        onChange={(event) => setLocale(event.target.value as SupportedLocale)}
      >
        {SUPPORTED_LOCALES.map((item) => (
          <option key={item} value={item}>
            {languageLabels[item]}
          </option>
        ))}
      </select>
    </label>
  );
}
