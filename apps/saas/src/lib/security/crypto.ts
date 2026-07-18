import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.DELIVERY_ACCOUNT_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("Missing DELIVERY_ACCOUNT_ENCRYPTION_KEY");
  }

  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    return Buffer.from(secret, "hex");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const [ivB64, tagB64, payloadB64] = value.split(":");
  if (!ivB64 || !tagB64 || !payloadB64) {
    throw new Error("Encrypted secret has invalid format");
  }

  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payloadB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}
