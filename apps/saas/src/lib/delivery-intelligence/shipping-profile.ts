import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export const SHIPPING_PROFILE_DECLARED_VALUE_MAX = 100000;
export const SHIPPING_PROFILE_WEIGHT_MAX = 50;
export const SHIPPING_PROFILE_DIMENSION_MAX = 200;

export const merchantShippingProfileSchema = z.object({
  sender_name: z.string().trim().min(1, "Sender name is required"),
  sender_phone: z.string().trim().min(1, "Sender phone is required"),
  from_wilaya_name: z.string().trim().min(1, "From wilaya is required"),
  from_commune_name: z.string().trim().min(1, "From commune is required"),
  default_product_list: z.string().trim().min(1, "Default product list is required"),
  default_declared_value: z.number().finite().positive("Declared value must be greater than zero").max(SHIPPING_PROFILE_DECLARED_VALUE_MAX, `Declared value must be at most ${SHIPPING_PROFILE_DECLARED_VALUE_MAX}.`),
  default_weight: z.number().finite().positive("Weight must be greater than zero").max(SHIPPING_PROFILE_WEIGHT_MAX, `Weight must be at most ${SHIPPING_PROFILE_WEIGHT_MAX}.`),
  default_length: z.number().finite().positive("Length must be greater than zero").max(SHIPPING_PROFILE_DIMENSION_MAX, `Length must be at most ${SHIPPING_PROFILE_DIMENSION_MAX}.`),
  default_width: z.number().finite().positive("Width must be greater than zero").max(SHIPPING_PROFILE_DIMENSION_MAX, `Width must be at most ${SHIPPING_PROFILE_DIMENSION_MAX}.`),
  default_height: z.number().finite().positive("Height must be greater than zero").max(SHIPPING_PROFILE_DIMENSION_MAX, `Height must be at most ${SHIPPING_PROFILE_DIMENSION_MAX}.`),
  default_do_insurance: z.boolean(),
  default_freeshipping: z.boolean(),
  default_is_stopdesk: z.boolean(),
  default_stopdesk_id: z.string().trim().min(1).optional().nullable(),
  return_center_code: z.string().trim().min(1).optional().nullable(),
}).superRefine((value, context) => {
  if (value.default_is_stopdesk && !value.default_stopdesk_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["default_stopdesk_id"],
      message: "Stopdesk ID is required when stopdesk shipping is enabled.",
    });
  }
});

export type MerchantShippingProfile = z.infer<typeof merchantShippingProfileSchema>;

export type MerchantShippingProfileRecord = MerchantShippingProfile & {
  id: string;
  merchant_id: string;
  created_at: string;
  updated_at: string;
};

function normalizeNullableText(value: FormDataEntryValue | null): string | null {
  if (value === null) {
    return null;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function parseBooleanField(value: FormDataEntryValue | null): boolean {
  if (value === null) {
    return false;
  }

  const text = String(value).trim().toLowerCase();
  return text === "1" || text === "true" || text === "on" || text === "yes";
}

function parseNumberField(value: FormDataEntryValue | null): number {
  const text = String(value ?? "").trim();
  return Number(text);
}

export function parseMerchantShippingProfileForm(formData: FormData) {
  return merchantShippingProfileSchema.parse({
    sender_name: normalizeNullableText(formData.get("sender_name")) ?? "",
    sender_phone: normalizeNullableText(formData.get("sender_phone")) ?? "",
    from_wilaya_name: normalizeNullableText(formData.get("from_wilaya_name")) ?? "",
    from_commune_name: normalizeNullableText(formData.get("from_commune_name")) ?? "",
    default_product_list: normalizeNullableText(formData.get("default_product_list")) ?? "",
    default_declared_value: parseNumberField(formData.get("default_declared_value")),
    default_weight: parseNumberField(formData.get("default_weight")),
    default_length: parseNumberField(formData.get("default_length")),
    default_width: parseNumberField(formData.get("default_width")),
    default_height: parseNumberField(formData.get("default_height")),
    default_do_insurance: parseBooleanField(formData.get("default_do_insurance")),
    default_freeshipping: parseBooleanField(formData.get("default_freeshipping")),
    default_is_stopdesk: parseBooleanField(formData.get("default_is_stopdesk")),
    default_stopdesk_id: normalizeNullableText(formData.get("default_stopdesk_id")),
    return_center_code: normalizeNullableText(formData.get("return_center_code")),
  });
}

export async function getMerchantShippingProfile(merchantId: string): Promise<MerchantShippingProfileRecord | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_shipping_profiles")
    .select("*")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as MerchantShippingProfileRecord | null;
}

export async function saveMerchantShippingProfile(merchantId: string, profile: MerchantShippingProfile): Promise<MerchantShippingProfileRecord> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchant_shipping_profiles")
    .upsert({
      merchant_id: merchantId,
      sender_name: profile.sender_name,
      sender_phone: profile.sender_phone,
      from_wilaya_name: profile.from_wilaya_name,
      from_commune_name: profile.from_commune_name,
      default_product_list: profile.default_product_list,
      default_declared_value: profile.default_declared_value,
      default_weight: profile.default_weight,
      default_length: profile.default_length,
      default_width: profile.default_width,
      default_height: profile.default_height,
      default_do_insurance: profile.default_do_insurance,
      default_freeshipping: profile.default_freeshipping,
      default_is_stopdesk: profile.default_is_stopdesk,
      default_stopdesk_id: profile.default_stopdesk_id ?? null,
      return_center_code: profile.return_center_code ?? null,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as MerchantShippingProfileRecord;
}
