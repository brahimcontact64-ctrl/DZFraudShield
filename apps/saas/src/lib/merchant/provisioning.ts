import { createClient } from "@/lib/supabase/server";
import { generateApiKey } from "@/lib/security/hash";
import { hashApiKeyForStorage } from "@/lib/security/api-key";

export type MerchantStoreInput = {
  merchantId: string;
  name: string;
  domain: string;
  siteUrl?: string | null;
  phone?: string | null;
  category?: string | null;
};

/**
 * Guarantees a merchant row exists for the given auth user.
 * Returns the merchantId. Safe to call on every login.
 */
export async function ensureMerchantForUser(user: {
  id: string;
  email: string | null;
}): Promise<string> {
  const supabase = createClient();

  const { data: existing } = await supabase
    .from("merchants")
    .select("id")
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return existing.id;
  }

  const merchantName = user.email
    ? `Merchant ${user.email.split("@")[0]}`
    : `Merchant ${user.id.slice(0, 8)}`;

  const { data: newMerchant, error: insertError } = await supabase
    .from("merchants")
    .insert({ owner_user_id: user.id, name: merchantName, email: user.email })
    .select("id")
    .single();

  if (insertError || !newMerchant) {
    // Race condition: another request created the merchant concurrently
    const { data: afterRace } = await supabase
      .from("merchants")
      .select("id")
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!afterRace?.id) {
      throw new Error(`Failed to create merchant: ${insertError?.message ?? "unknown"}`);
    }

    return afterRace.id;
  }

  return newMerchant.id;
}

/**
 * Guarantees at least one active API key exists for the merchant.
 * Only creates a default key if none exists. Never creates duplicates.
 */
export async function ensureDefaultApiKey(merchantId: string, options?: { returnPlainKey?: boolean }): Promise<string | null> {
  const supabase = createClient();

  const { data: existing } = await supabase
    .from("merchant_api_keys")
    .select("id")
    .eq("merchant_id", merchantId)
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return null;
  }

  const plainKey = generateApiKey();
  const keyHash = hashApiKeyForStorage(plainKey);
  const prefix = plainKey.slice(0, 10);

  await supabase.from("merchant_api_keys").insert({
    merchant_id: merchantId,
    key_name: "Default Key",
    key_prefix: prefix,
    api_key_hash: keyHash,
    is_active: true
  });

  return options?.returnPlainKey ? plainKey : null;
}

/**
 * Issues a new merchant API key and returns the plaintext value once.
 * Intended for onboarding/bootstrap flows that need to hand the key to the plugin.
 */
export async function issueMerchantApiKey(merchantId: string, keyName = "Default Key"): Promise<string> {
  const supabase = createClient();
  const plainKey = generateApiKey();
  const keyHash = hashApiKeyForStorage(plainKey);
  const prefix = plainKey.slice(0, 10);

  const { error } = await supabase.from("merchant_api_keys").insert({
    merchant_id: merchantId,
    key_name: keyName,
    key_prefix: prefix,
    api_key_hash: keyHash,
    is_active: true
  });

  if (error) {
    throw new Error(`Failed to create API key: ${error.message}`);
  }

  return plainKey;
}

export async function ensureMerchantStore(input: MerchantStoreInput): Promise<{ id: string }> {
  const supabase = createClient();

  const { data: existing, error: lookupError } = await supabase
    .from("stores")
    .select("id")
    .eq("merchant_id", input.merchantId)
    .eq("domain", input.domain)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to look up store: ${lookupError.message}`);
  }

  const payload = {
    merchant_id: input.merchantId,
    name: input.name,
    domain: input.domain,
    site_url: input.siteUrl ?? null,
    phone: input.phone ?? null,
    category: input.category ?? null,
    platform: "woocommerce",
    updated_at: new Date().toISOString()
  };

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("stores")
      .update(payload)
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Failed to update store: ${updateError.message}`);
    }

    return { id: existing.id };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("stores")
    .insert(payload)
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`Failed to create store: ${insertError?.message ?? "unknown"}`);
  }

  return { id: inserted.id };
}

/**
 * Fully provisions a merchant account for the given auth user:
 * 1. Creates merchant if not exists.
 * 2. Creates default API key if not exists.
 *
 * Idempotent — safe to call on every login or signup.
 */
export async function provisionMerchant(user: {
  id: string;
  email: string | null;
}): Promise<{ merchantId: string }> {
  const merchantId = await ensureMerchantForUser(user);
  await ensureDefaultApiKey(merchantId);
  return { merchantId };
}
