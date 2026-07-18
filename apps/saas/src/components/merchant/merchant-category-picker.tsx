import { MERCHANT_CATEGORY_OPTIONS, type MerchantCategoryValue } from "@/lib/merchant/categories";
import { getI18nServer } from "@/lib/i18n/server";

export async function MerchantCategoryPicker(props: {
  currentCategory: MerchantCategoryValue;
  action: string;
  returnTo: string;
  title: string;
  description: string;
  buttonLabel: string;
  helperText: string;
}) {
  const { t } = await getI18nServer();

  return (
    <form method="post" action={props.action} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{props.title}</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">{props.description}</h2>
        </div>
        <p className="text-sm text-slate-500">{t("merchantCategory.usedBy")}</p>
      </div>

      <input type="hidden" name="returnTo" value={props.returnTo} />

      <label className="mt-4 block space-y-1.5">
        <span className="text-sm font-medium text-slate-700">{t("merchantCategory.label")} <span className="text-rose-500">*</span></span>
        <select
          name="merchant_category"
          defaultValue={props.currentCategory}
          required
          className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/10"
        >
          {MERCHANT_CATEGORY_OPTIONS.map((category) => (
            <option key={category.value} value={category.value}>{t(`merchantCategory.${category.value}`)}</option>
          ))}
        </select>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-soft">{props.buttonLabel}</button>
        <p className="text-xs text-slate-500">{props.helperText}</p>
      </div>
    </form>
  );
}