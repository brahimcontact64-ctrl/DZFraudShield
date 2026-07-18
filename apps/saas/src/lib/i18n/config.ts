export const SUPPORTED_LOCALES = ["ar", "fr", "en"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "ar";

export const LOCALE_COOKIE_NAME = "dzfs_locale";

export function isSupportedLocale(input: string | null | undefined): input is SupportedLocale {
  return Boolean(input && SUPPORTED_LOCALES.includes(input as SupportedLocale));
}

export function getDirection(locale: SupportedLocale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
