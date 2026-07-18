import { createHash } from "node:crypto";

/**
 * Computes a deterministic event_id for a Yalidine webhook event.
 *
 * Algorithm:
 *   SHA-256( merchantId + "|" + tracking + "|" + eventType + "|" + dateLastStatus )
 *
 * Properties:
 *   - Deterministic: the same logical event always produces the same event_id.
 *     Yalidine may deliver the same event more than once; the UNIQUE constraint
 *     on webhook_event_log(merchant_id, provider, event_id) makes the second
 *     insert fail with 23505, which the handler treats as a duplicate and skips.
 *
 *   - Compact: 64 hex chars, safe for any text column.
 *
 *   - Credential-free: does not require the apiKey. This means the event_id can
 *     be computed before HMAC validation — useful for logging decisions — but
 *     in practice the handler always validates first and only inserts valid events.
 *
 *   - Cross-merchant safe: merchantId is a component, so two merchants receiving
 *     updates for the same tracking number produce distinct event_ids.
 *
 * Input fields:
 *   - merchantId:     The platform merchant UUID.
 *   - tracking:       The Yalidine tracking number from the webhook payload.
 *   - eventType:      Webhook event type (e.g. "parcel_status_updated").
 *   - dateLastStatus: ISO-8601 timestamp of the status that triggered this event,
 *                     or the sentinel string "unknown" when the provider omits it.
 *                     Using the provider's own timestamp (not the arrival time)
 *                     makes the event_id stable across re-deliveries.
 */
export function computeWebhookEventId(params: {
  merchantId: string;
  tracking: string;
  eventType: string;
  dateLastStatus: string;
}): string {
  const raw = [
    params.merchantId,
    params.tracking,
    params.eventType,
    params.dateLastStatus,
  ].join("|");

  return createHash("sha256").update(raw, "utf8").digest("hex");
}
