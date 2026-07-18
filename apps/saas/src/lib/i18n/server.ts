import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isSupportedLocale, LOCALE_COOKIE_NAME, type SupportedLocale } from "@/lib/i18n/config";
import { getDictionary, translate } from "@/lib/i18n/dictionaries";

export function getLocaleFromRequest(): SupportedLocale {
  const localeCookie = cookies().get(LOCALE_COOKIE_NAME)?.value;
  if (isSupportedLocale(localeCookie)) {
    return localeCookie;
  }

  return DEFAULT_LOCALE;
}

export async function getI18nServer() {
  const locale = getLocaleFromRequest();
  const localeDict = getDictionary(locale);
  const fallback = getDictionary("en");

  return {
    locale,
    dir: locale === "ar" ? "rtl" as const : "ltr" as const,
    t: (key: string, params?: Record<string, string | number>) => translate(localeDict, fallback, key, params),
  };
}
