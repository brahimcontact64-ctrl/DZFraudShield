import type { NormalizedDeliveryStatus, NormalizedOutcomeReason } from "@/lib/delivery-intelligence/types";

type JsonRecord = Record<string, unknown>;

const KNOWN_OUTCOME_REASONS = new Set<NormalizedOutcomeReason>([
  "DELIVERED",
  "RETURNED",
  "CLIENT_CANCELLED",
  "NO_ANSWER",
  "FAKE_ORDER",
  "PHONE_UNREACHABLE",
  "REFUSED",
  "NOT_PICKED_UP",
  "BAD_ADDRESS",
  "PENDING"
]);

function readPath(value: unknown, path: string): unknown {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  let cursor: unknown = value;

  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }

    cursor = (cursor as JsonRecord)[segment];
  }

  return cursor;
}

function toAsciiLower(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeToken(value: string): string {
  return toAsciiLower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function coerceString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function defaultReasonFromStatus(status: NormalizedDeliveryStatus): NormalizedOutcomeReason {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "RETURNED") return "RETURNED";
  if (status === "REFUSED") return "REFUSED";
  if (status === "CANCELLED") return "CLIENT_CANCELLED";
  return "PENDING";
}

export function coerceNormalizedOutcomeReason(value: unknown): NormalizedOutcomeReason | null {
  const token = normalizeToken(String(value ?? "")).toUpperCase();
  if (KNOWN_OUTCOME_REASONS.has(token as NormalizedOutcomeReason)) {
    return token as NormalizedOutcomeReason;
  }

  return null;
}

export function normalizeOutcomeReason(params: {
  normalizedStatus: NormalizedDeliveryStatus;
  providerStatusRaw?: string | null;
  providerSituationRaw?: string | null;
  providerReasonRaw?: string | null;
}): NormalizedOutcomeReason {
  const joined = [params.providerReasonRaw, params.providerSituationRaw, params.providerStatusRaw]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => toAsciiLower(value))
    .join(" | ");

  const token = normalizeToken(joined);

  if (/(adresse|address).*(incorrect|wrong|invalid)|bad_address|adresse_incorrecte/.test(token)) {
    return "BAD_ADDRESS";
  }

  if (/(injoignable|eteint|unreachable|not_reachable|telephone_hors_service|phone_off)/.test(token)) {
    return "PHONE_UNREACHABLE";
  }

  if (/(ne_repond|sans_reponse|no_answer|no_response|does_not_answer|appel_sans_reponse)/.test(token)) {
    return "NO_ANSWER";
  }

  if (/(fake_order|fausse_commande|faux|false_order|fraud)/.test(token)) {
    return "FAKE_ORDER";
  }

  if (/(refuse|refusee|refused|reject)/.test(token)) {
    return "REFUSED";
  }

  if (/(non_recup|not_picked|bureau|pickup_point|attente_recuperation_fournisseur)/.test(token)) {
    return "NOT_PICKED_UP";
  }

  if (/(annul|cancel|commande_anullee|commande_annulee|client_absent)/.test(token)) {
    return "CLIENT_CANCELLED";
  }

  if (/(recouvert|livr|delivered|success|completed|done)/.test(token)) {
    return "DELIVERED";
  }

  if (/(retour|returned|return_to_sender|recupere_par_fournisseur|echec_livraison)/.test(token)) {
    return "RETURNED";
  }

  return defaultReasonFromStatus(params.normalizedStatus);
}

export function outcomeReasonLabel(reason: string | null | undefined): string {
  switch ((reason ?? "").toUpperCase()) {
    case "DELIVERED":
      return "Delivered";
    case "RETURNED":
      return "Returned";
    case "CLIENT_CANCELLED":
      return "Client Cancelled Order";
    case "NO_ANSWER":
      return "Customer Did Not Answer";
    case "FAKE_ORDER":
      return "Fake Order";
    case "PHONE_UNREACHABLE":
      return "Phone Unreachable";
    case "REFUSED":
      return "Refused";
    case "NOT_PICKED_UP":
      return "Not Picked Up";
    case "BAD_ADDRESS":
      return "Bad Address";
    case "PENDING":
      return "Pending";
    default:
      return reason ? reason.replace(/_/g, " ") : "-";
  }
}

export function extractOutcomeContext(params: {
  payload: Record<string, unknown>;
  normalizedStatus: NormalizedDeliveryStatus;
}): {
  providerStatusRaw: string | null;
  providerSituationRaw: string | null;
  providerReasonRaw: string | null;
  normalizedOutcomeReason: NormalizedOutcomeReason;
} {
  const payload = params.payload;

  const providerStatusRaw =
    coerceString(payload.last_status)
    ?? coerceString(readPath(payload, "state.name"))
    ?? coerceString(readPath(payload, "parcelState.name"))
    ?? coerceString(payload.state)
    ?? coerceString(payload.parcelState)
    ?? coerceString(payload.status)
    ?? coerceString(readPath(payload, "status.name"));

  const providerSituationRaw =
    coerceString(readPath(payload, "situation.name"))
    ?? coerceString(readPath(payload, "situation.slug"))
    ?? coerceString(readPath(payload, "situation.description"))
    ?? coerceString(payload.situation);

  const providerReasonRaw =
    coerceString(readPath(payload, "situation.metadata.comment"))
    ?? coerceString(payload.reason)
    ?? coerceString(payload.comment)
    ?? coerceString(payload.motif)
    ?? coerceString(payload.motifRetour)
    ?? coerceString(payload.failureReason)
    ?? coerceString(payload.returnReason)
    ?? coerceString(readPath(payload, "return.reason"));

  return {
    providerStatusRaw,
    providerSituationRaw,
    providerReasonRaw,
    normalizedOutcomeReason: normalizeOutcomeReason({
      normalizedStatus: params.normalizedStatus,
      providerStatusRaw,
      providerSituationRaw,
      providerReasonRaw
    })
  };
}
