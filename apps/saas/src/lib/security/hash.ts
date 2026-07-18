import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashWithSecret(value: string, secret: string): string {
  return digest(`${secret}:${value.trim().toLowerCase()}`);
}

export function hashApiKey(rawKey: string, secret: string): string {
  return hashWithSecret(rawKey, secret);
}

export function generateApiKey(): string {
  return `dzfs_${randomBytes(20).toString("hex")}`;
}

export function secureCompare(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  if (first.length !== second.length) {
    return false;
  }
  return timingSafeEqual(first, second);
}
