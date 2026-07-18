import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { ALGERIA_WILAYAS } from "@/lib/delivery-intelligence/algeria-wilayas";

const shippingOriginInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(50).default("yalidine"),
  wilaya_id: z.string().trim().min(1).max(120),
  wilaya_name: z.string().trim().min(1).max(120),
  office_id: z.string().trim().min(1).max(120).nullable().optional(),
  office_name: z.string().trim().min(1).max(160).nullable().optional(),
  sender_name: z.string().trim().min(1).max(160),
  sender_phone: z.string().trim().min(1).max(64),
  sender_address: z.string().trim().min(1).max(500),
  is_default: z.boolean().optional().default(false),
});

export type ShippingOriginInput = z.infer<typeof shippingOriginInputSchema>;

export type ShippingOriginRecord = {
  id: string;
  merchant_id: string;
  name: string;
  provider: string;
  wilaya_id: string;
  wilaya_name: string;
  office_id: string | null;
  office_name: string | null;
  sender_name: string;
  sender_phone: string;
  sender_address: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

function normalizeNullable(value: string | null | undefined): string | null {
  if (!value) return null;
  const next = String(value).trim();
  return next.length > 0 ? next : null;
}

function normalizePayload(input: ShippingOriginInput) {
  return {
    ...input,
    office_id: normalizeNullable(input.office_id ?? null),
    office_name: normalizeNullable(input.office_name ?? null),
  };
}

async function hasAnyOrigin(merchantId: string, provider: string): Promise<boolean> {
  const supabase = createClient();
  const { count, error } = await supabase
    .from("shipping_origins")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("provider", provider);

  if (error) {
    throw error;
  }

  return Number(count ?? 0) > 0;
}

async function clearDefaultForProvider(merchantId: string, provider: string) {
  const supabase = createClient();
  const { error } = await supabase
    .from("shipping_origins")
    .update({
      is_default: false,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .eq("is_default", true);

  if (error) {
    throw error;
  }
}

export function parseShippingOriginInput(payload: unknown): ShippingOriginInput {
  return shippingOriginInputSchema.parse(payload);
}

export async function listShippingOrigins(merchantId: string, provider = "yalidine"): Promise<ShippingOriginRecord[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("shipping_origins")
    .select("id,merchant_id,name,provider,wilaya_id,wilaya_name,office_id,office_name,sender_name,sender_phone,sender_address,is_default,created_at,updated_at")
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as ShippingOriginRecord[];
}

export async function getShippingOriginById(merchantId: string, originId: string): Promise<ShippingOriginRecord | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("shipping_origins")
    .select("id,merchant_id,name,provider,wilaya_id,wilaya_name,office_id,office_name,sender_name,sender_phone,sender_address,is_default,created_at,updated_at")
    .eq("merchant_id", merchantId)
    .eq("id", originId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as ShippingOriginRecord | null;
}

export async function getDefaultShippingOrigin(merchantId: string, provider = "yalidine"): Promise<ShippingOriginRecord | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("shipping_origins")
    .select("id,merchant_id,name,provider,wilaya_id,wilaya_name,office_id,office_name,sender_name,sender_phone,sender_address,is_default,created_at,updated_at")
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .eq("is_default", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data) {
    return data as ShippingOriginRecord;
  }

  const all = await listShippingOrigins(merchantId, provider);
  return all[0] ?? null;
}

export async function createShippingOrigin(merchantId: string, input: ShippingOriginInput): Promise<ShippingOriginRecord> {
  const payload = normalizePayload(input);
  const provider = payload.provider;
  const shouldSetDefault = payload.is_default || !(await hasAnyOrigin(merchantId, provider));

  if (shouldSetDefault) {
    await clearDefaultForProvider(merchantId, provider);
  }

  const supabase = createClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("shipping_origins")
    .insert({
      merchant_id: merchantId,
      name: payload.name,
      provider,
      wilaya_id: payload.wilaya_id,
      wilaya_name: payload.wilaya_name,
      office_id: payload.office_id,
      office_name: payload.office_name,
      sender_name: payload.sender_name,
      sender_phone: payload.sender_phone,
      sender_address: payload.sender_address,
      is_default: shouldSetDefault,
      created_at: now,
      updated_at: now,
    })
    .select("id,merchant_id,name,provider,wilaya_id,wilaya_name,office_id,office_name,sender_name,sender_phone,sender_address,is_default,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data as ShippingOriginRecord;
}

export async function updateShippingOrigin(merchantId: string, originId: string, input: ShippingOriginInput): Promise<ShippingOriginRecord> {
  const current = await getShippingOriginById(merchantId, originId);
  if (!current) {
    throw new Error("shipping_origin_not_found");
  }

  const payload = normalizePayload(input);
  const provider = payload.provider || current.provider;
  const shouldSetDefault = Boolean(payload.is_default);

  if (shouldSetDefault) {
    await clearDefaultForProvider(merchantId, provider);
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("shipping_origins")
    .update({
      name: payload.name,
      provider,
      wilaya_id: payload.wilaya_id,
      wilaya_name: payload.wilaya_name,
      office_id: payload.office_id,
      office_name: payload.office_name,
      sender_name: payload.sender_name,
      sender_phone: payload.sender_phone,
      sender_address: payload.sender_address,
      is_default: shouldSetDefault,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("id", originId)
    .select("id,merchant_id,name,provider,wilaya_id,wilaya_name,office_id,office_name,sender_name,sender_phone,sender_address,is_default,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  if (current.is_default && !shouldSetDefault) {
    const fallback = (await listShippingOrigins(merchantId, provider)).find((item) => item.id !== originId) ?? null;
    if (fallback) {
      await setDefaultShippingOrigin(merchantId, fallback.id, provider);
    }
  }

  return data as ShippingOriginRecord;
}

export async function deleteShippingOrigin(merchantId: string, originId: string): Promise<void> {
  const current = await getShippingOriginById(merchantId, originId);
  if (!current) {
    return;
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("shipping_origins")
    .delete()
    .eq("merchant_id", merchantId)
    .eq("id", originId);

  if (error) {
    throw error;
  }

  if (current.is_default) {
    const fallback = (await listShippingOrigins(merchantId, current.provider))[0] ?? null;
    if (fallback) {
      await setDefaultShippingOrigin(merchantId, fallback.id, current.provider);
    }
  }
}

/**
 * Creates a default shipping origin for a merchant if none exists yet.
 * Called by sync-fees so that getGlobalShippingPrice can resolve originWilayaId
 * at checkout. Populates every known field from the plugin payload; sender
 * fields are left empty for the merchant to complete via the Dashboard UI.
 * The function is idempotent: it exits immediately if any origin already exists
 * (hasAnyOrigin guard), and the underlying upsert uses ignoreDuplicates so
 * concurrent calls cannot produce duplicate rows.
 */
export async function ensureDefaultShippingOrigin(
  merchantId: string,
  options: {
    provider?: string;
    wilayaId: string;
    officeId?: string | null;
    centerName?: string | null;
  },
): Promise<{ created: boolean }> {
  const provider = options.provider ?? "yalidine";

  // Common case: at least one origin already exists — no-op.
  const already = await hasAnyOrigin(merchantId, provider);
  if (already) {
    return { created: false };
  }

  const supabase = createClient();
  const now = new Date().toISOString();

  // Resolve the canonical wilaya name from the static Algeria dataset.
  const wilayaName =
    ALGERIA_WILAYAS.find((w) => w.id === options.wilayaId.padStart(2, "0"))?.name ??
    options.wilayaId;

  const centerName = options.centerName?.trim() || null;
  const name = centerName ?? (options.officeId ? `Center ${options.officeId}` : "Default Origin");

  // Use upsert with ignoreDuplicates on the (merchant_id, provider, name)
  // unique index so that a concurrent insert of the same row is a no-op rather
  // than an error — covers the rare race between two simultaneous sync calls.
  const { data: inserted, error } = await supabase
    .from("shipping_origins")
    .upsert(
      {
        merchant_id:    merchantId,
        provider,
        name,
        wilaya_id:      options.wilayaId,
        wilaya_name:    wilayaName,
        office_id:      options.officeId ?? null,
        office_name:    centerName,
        sender_name:    "",
        sender_phone:   "",
        sender_address: "",
        is_default:     true,
        created_at:     now,
        updated_at:     now,
      },
      { onConflict: "merchant_id,provider,name", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return { created: inserted !== null };
}

/**
 * Upserts the Yalidine shipping origin from a sync-fees call.
 *
 * - Creates the row if no origin exists yet (first-time setup).
 * - Updates wilaya_id / office_id when the merchant changes their departure
 *   center so that delivery_prices lookups use the correct departure_center_id.
 * - Returns { created, updated, previousWilayaId } so callers know whether
 *   a re-sync of delivery_prices is needed.
 *
 * Does NOT touch sender_name / sender_phone / sender_address — the merchant
 * fills those via the Dashboard shipping-origins UI.
 */
export async function syncShippingOriginFromFees(
  merchantId: string,
  params: { wilayaId: string; officeId?: string | null; centerName?: string | null },
): Promise<{ created: boolean; updated: boolean; previousWilayaId: string | null }> {
  const provider = "yalidine";
  const supabase = createClient();

  const { data: existing } = await supabase
    .from("shipping_origins")
    .select("id,wilaya_id,office_id")
    .eq("merchant_id", merchantId)
    .eq("provider", provider)
    .eq("is_default", true)
    .limit(1)
    .maybeSingle();

  if (!existing) {
    // First-time: create via the standard path (also handles concurrent inserts safely)
    await ensureDefaultShippingOrigin(merchantId, {
      provider,
      wilayaId:   params.wilayaId,
      officeId:   params.officeId ?? null,
      centerName: params.centerName ?? null,
    });
    return { created: true, updated: false, previousWilayaId: null };
  }

  const prev = existing as { id: string; wilaya_id: string; office_id: string | null };
  const wilayaChanged = prev.wilaya_id !== params.wilayaId;
  const officeChanged  = params.officeId != null && params.officeId !== "" && params.officeId !== prev.office_id;

  if (!wilayaChanged && !officeChanged) {
    return { created: false, updated: false, previousWilayaId: prev.wilaya_id };
  }

  const wilayaName =
    ALGERIA_WILAYAS.find((w) => w.id === params.wilayaId.padStart(2, "0"))?.name ??
    params.wilayaId;
  const centerName = params.centerName?.trim() || null;

  await supabase
    .from("shipping_origins")
    .update({
      wilaya_id:   params.wilayaId,
      wilaya_name: wilayaName,
      office_id:   params.officeId ?? prev.office_id,
      office_name: centerName,
      is_default:  true,
      updated_at:  new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("id", prev.id);

  console.log(
    `[shipping-origins] merchant=${merchantId} center changed:` +
    ` wilaya ${prev.wilaya_id}→${params.wilayaId}` +
    ` office ${prev.office_id ?? "—"}→${params.officeId ?? "—"}`,
  );

  return { created: false, updated: true, previousWilayaId: prev.wilaya_id };
}

export async function setDefaultShippingOrigin(merchantId: string, originId: string, provider = "yalidine"): Promise<ShippingOriginRecord> {
  await clearDefaultForProvider(merchantId, provider);

  const supabase = createClient();
  const { data, error } = await supabase
    .from("shipping_origins")
    .update({
      is_default: true,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("id", originId)
    .eq("provider", provider)
    .select("id,merchant_id,name,provider,wilaya_id,wilaya_name,office_id,office_name,sender_name,sender_phone,sender_address,is_default,created_at,updated_at")
    .single();

  if (error) {
    throw error;
  }

  return data as ShippingOriginRecord;
}