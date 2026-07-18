/**
 * Deterministic date/number formatting utilities.
 *
 * All formatters use a fixed locale (fr-DZ) and timezone (Africa/Algiers) so
 * that server-side rendering and client hydration produce identical strings.
 * Never use bare toLocaleString() / toLocaleDateString() in JSX — those pick
 * up the runtime locale and produce hydration mismatches between the Node.js
 * server and the browser.
 */

const LOCALE = "fr-DZ";
const TZ = "Africa/Algiers";

const dtFull = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: TZ,
});

const dtDateOnly = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "short",
  timeZone: TZ,
});

const dtTimeOnly = new Intl.DateTimeFormat(LOCALE, {
  timeStyle: "short",
  timeZone: TZ,
});

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return isNaN(d.getTime()) ? null : d;
}

/** 14/07/2026, 18:28:13 — always same on server and client */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dtFull.format(d) : "-";
}

/** 14/07/2026 */
export function formatDateOnly(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dtDateOnly.format(d) : "-";
}

/** 18:28 */
export function formatTimeOnly(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dtTimeOnly.format(d) : "-";
}

/** 1 234 567 — locale-stable number with French thousands separator */
export function formatNumber(value: number | null | undefined, locale = LOCALE): string {
  if (value == null) return "-";
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
