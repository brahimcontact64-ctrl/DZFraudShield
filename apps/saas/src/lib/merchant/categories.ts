export const MERCHANT_CATEGORY_OPTIONS = [
  { value: "fashion", label: "Fashion" },
  { value: "shoes", label: "Shoes" },
  { value: "electronics", label: "Electronics" },
  { value: "cosmetics", label: "Cosmetics" },
  { value: "home", label: "Home" },
  { value: "food", label: "Food" },
  { value: "general_store", label: "General Store" },
] as const;

export const MERCHANT_CATEGORY_VALUES = MERCHANT_CATEGORY_OPTIONS.map((option) => option.value) as [MerchantCategoryValue, ...MerchantCategoryValue[]];

export type MerchantCategoryValue = (typeof MERCHANT_CATEGORY_OPTIONS)[number]["value"];

const CATEGORY_ALIASES: Record<string, MerchantCategoryValue> = {
  beauty: "cosmetics",
  "beauty_&_cosmetics": "cosmetics",
  fashion: "fashion",
  "fashion_&_clothing": "fashion",
  clothes: "fashion",
  apparel: "fashion",
  shoes: "shoes",
  footwear: "shoes",
  electronics: "electronics",
  tech: "electronics",
  "home_&_kitchen": "home",
  cosmetics: "cosmetics",
  makeup: "cosmetics",
  home: "home",
  home_decor: "home",
  decor: "home",
  food: "food",
  "food_&_grocery": "food",
  food_grocery: "food",
  grocery: "food",
  "general_store": "general_store",
  "general_store_&_more": "general_store",
  "general_store_&_multi_category": "general_store",
  "general_store_&_mixed": "general_store",
  "general_store_&_other": "general_store",
  "multi_category_store": "general_store",
  general: "general_store",
  store: "general_store",
  other: "general_store",
};

const SUPPORTED_CATEGORY_VALUES = new Set(MERCHANT_CATEGORY_OPTIONS.map((option) => option.value));

export function normalizeMerchantCategory(input: string | null | undefined): MerchantCategoryValue {
  const raw = String(input ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!raw) {
    return "general_store";
  }

  const alias = CATEGORY_ALIASES[raw];
  if (alias) {
    return alias;
  }

  if (SUPPORTED_CATEGORY_VALUES.has(raw as MerchantCategoryValue)) {
    return raw as MerchantCategoryValue;
  }

  return "general_store";
}