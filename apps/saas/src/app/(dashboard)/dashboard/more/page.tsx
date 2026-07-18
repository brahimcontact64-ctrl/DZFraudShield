import { getI18nServer } from "@/lib/i18n/server";

export default async function MorePage() {
  const { t } = await getI18nServer();
  const links = [
    { href: "/dashboard/inventory", titleKey: "dashboard.inventory.title", descriptionKey: "dashboard.inventory.subtitle" },
    { href: "/dashboard/stores", titleKey: "dashboard.stores.title", descriptionKey: "dashboard.stores.subtitle" },
    { href: "/dashboard/delivery-providers", titleKey: "dashboard.deliveryProviders.title", descriptionKey: "dashboard.deliveryProviders.subtitle" },
    { href: "/dashboard/api-keys", titleKey: "dashboard.apiKeys.title", descriptionKey: "dashboard.apiKeys.subtitle" },
    { href: "/dashboard/settings", titleKey: "dashboard.settings.title", descriptionKey: "dashboard.settings.subtitle" },
    { href: "/dashboard/notifications", titleKey: "dashboard.notifications.title", descriptionKey: "dashboard.notifications.subtitle" },
  ];
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">{t("dashboard.more.tag")}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{t("dashboard.more.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">{t("dashboard.more.subtitle")}</p>
      </section>

      <div className="space-y-3">
        {links.map((item) => (
          <a key={item.href} href={item.href} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)] hover:border-slate-300">
            <p className="text-base font-semibold text-slate-900">{t(item.titleKey)}</p>
            <p className="mt-1 text-sm text-slate-600">{t(item.descriptionKey)}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
