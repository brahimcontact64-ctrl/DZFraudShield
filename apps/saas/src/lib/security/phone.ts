const ALGERIA_COUNTRY_CODE = "+213";
const MOBILE_PREFIXES = new Set(["5", "6", "7"]);

export function normalizeAlgerianPhone(input: string): string | null {
  if (!input) {
    return null;
  }

  const cleaned = input.replace(/[^\d+]/g, "");
  let national = "";

  if (cleaned.startsWith("+213")) {
    national = cleaned.slice(4);
  } else if (cleaned.startsWith("00213")) {
    national = cleaned.slice(5);
  } else if (cleaned.startsWith("213")) {
    national = cleaned.slice(3);
  } else if (cleaned.startsWith("0")) {
    national = cleaned.slice(1);
  } else {
    national = cleaned;
  }

  if (national.length !== 9) {
    return null;
  }

  if (!MOBILE_PREFIXES.has(national[0])) {
    return null;
  }

  if (!/^\d{9}$/.test(national)) {
    return null;
  }

  return `${ALGERIA_COUNTRY_CODE}${national}`;
}
