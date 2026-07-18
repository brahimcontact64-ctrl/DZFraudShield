import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Yalidine webhook HMAC-SHA256 signature.
 *
 * Yalidine signs the exact raw request body bytes (no re-serialization) with
 * HMAC-SHA256 using the merchant's apiKey as the signing secret. The result is
 * hex-encoded and sent in the X-Yalidine-Hmac-Sha256 request header.
 *
 * This function must receive the original raw body bytes as they arrived on
 * the wire — do NOT stringify or re-serialize the JSON before calling this.
 *
 * The comparison is constant-time to prevent timing-based signature forgery.
 */
export function verifyYalidineHmac(
  rawBody: Buffer,
  signature: string,
  apiKey: string,
): boolean {
  if (!signature || !apiKey) return false;

  const expected = createHmac("sha256", apiKey).update(rawBody).digest("hex");

  // Both sides are lowercase hex, same length. timingSafeEqual requires identical
  // byte length — checked first to avoid a length-leak timing side-channel.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Computes the CRC response token for Yalidine's webhook URL verification.
 *
 * When Yalidine verifies a webhook URL it sends:
 *   GET /api/webhooks/yalidine?crc_token={token}
 *
 * The receiver must respond with:
 *   { "response_token": HMAC-SHA256(crcToken, apiKey) }
 */
export function computeYalidineCrcToken(crcToken: string, apiKey: string): string {
  return createHmac("sha256", apiKey).update(crcToken, "utf8").digest("hex");
}
