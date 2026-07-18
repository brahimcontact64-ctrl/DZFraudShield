import ar from "../../../locales/ar.json";
import en from "../../../locales/en.json";
import fr from "../../../locales/fr.json";
import type { SupportedLocale } from "@/lib/i18n/config";

export type Dictionary = Record<string, unknown>;

const dictionaries: Record<SupportedLocale, Dictionary> = {
  ar,
  fr,
  en,
};

export function getDictionary(locale: SupportedLocale): Dictionary {
  return dictionaries[locale];
}

function getNestedValue(dict: Dictionary, key: string): string | null {
  const parts = key.split(".");
  let cursor: unknown = dict;

  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !(part in (cursor as Record<string, unknown>))) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  return typeof cursor === "string" ? cursor : null;
}

export function translate(localeDict: Dictionary, fallbackDict: Dictionary, key: string, params?: Record<string, string | number>): string {
  const template = getNestedValue(localeDict, key) ?? getNestedValue(fallbackDict, key) ?? key;

  if (!params) {
    return template;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) => {
    const value = params[token];
    return value === undefined ? "" : String(value);
  });
}
