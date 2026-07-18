import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseSecretLine(rawLine: string, key: string): string | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  if (!line.startsWith(`${key}=`)) return null;

  const value = line.slice(key.length + 1).trim();
  if (!value) return null;

  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readSecretFromEnvFiles(key: string): string | null {
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env.local"),
    resolve(process.cwd(), "../.env")
  ];

  for (const filePath of candidates) {
    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const parsed = parseSecretLine(line, key);
        if (parsed) return parsed;
      }
    } catch {
      // Ignore missing files and continue searching.
    }
  }

  return null;
}

export function getApiKeySigningSecret(): string {
  const envSecret = process.env.API_KEY_SIGNING_SECRET?.trim() ?? "";
  const fileSecret = readSecretFromEnvFiles("API_KEY_SIGNING_SECRET")?.trim() ?? "";

  const secret = fileSecret || envSecret;
  if (!secret) {
    throw new Error("Missing API_KEY_SIGNING_SECRET");
  }

  return secret;
}

export function getLegacyApiKeySigningSecret(): string | null {
  const envSecret = process.env.API_KEY_SIGNING_SECRET?.trim() ?? "";
  const canonical = getApiKeySigningSecret();

  if (!envSecret || envSecret === canonical) {
    return null;
  }

  return envSecret;
}
