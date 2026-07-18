import { describe, expect, it } from "vitest";
import { merchantShippingProfileSchema, parseMerchantShippingProfileForm } from "@/lib/delivery-intelligence/shipping-profile";

describe("merchant shipping profile validation", () => {
  it("requires the shipping identity fields", () => {
    const result = merchantShippingProfileSchema.safeParse({
      sender_name: "",
      sender_phone: "",
      from_wilaya_name: "",
      from_commune_name: "",
      default_product_list: "",
      default_declared_value: 0,
      default_weight: 0,
      default_length: 0,
      default_width: 0,
      default_height: 0,
      default_do_insurance: false,
      default_freeshipping: false,
      default_is_stopdesk: false,
      default_stopdesk_id: null,
      return_center_code: null,
    });

    expect(result.success).toBe(false);
  });

  it("requires stopdesk_id when stopdesk shipping is enabled", () => {
    const result = merchantShippingProfileSchema.safeParse({
      sender_name: "Merchant Sender",
      sender_phone: "0550000000",
      from_wilaya_name: "Alger",
      from_commune_name: "Alger Centre",
      default_product_list: "COD parcel",
      default_declared_value: 2300,
      default_weight: 1,
      default_length: 10,
      default_width: 10,
      default_height: 10,
      default_do_insurance: false,
      default_freeshipping: false,
      default_is_stopdesk: true,
      default_stopdesk_id: null,
      return_center_code: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "default_stopdesk_id")).toBe(true);
    }
  });

  it("parses form data for a valid profile", () => {
    const formData = new FormData();
    formData.set("sender_name", "Merchant Sender");
    formData.set("sender_phone", "0550000000");
    formData.set("from_wilaya_name", "Alger");
    formData.set("from_commune_name", "Alger Centre");
    formData.set("default_product_list", "COD parcel");
    formData.set("default_declared_value", "2300");
    formData.set("default_weight", "1");
    formData.set("default_length", "10");
    formData.set("default_width", "10");
    formData.set("default_height", "10");
    formData.set("default_do_insurance", "on");
    formData.set("default_freeshipping", "");
    formData.set("default_is_stopdesk", "");
    formData.set("default_stopdesk_id", "");
    formData.set("return_center_code", "RCC-01");

    const profile = parseMerchantShippingProfileForm(formData);
    expect(profile.sender_name).toBe("Merchant Sender");
    expect(profile.default_declared_value).toBe(2300);
    expect(profile.default_do_insurance).toBe(true);
    expect(profile.return_center_code).toBe("RCC-01");
  });
});
