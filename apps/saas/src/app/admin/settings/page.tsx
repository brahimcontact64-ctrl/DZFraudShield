import Link from "next/link";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default function AdminSettingsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">Settings</AdminBadge>
        <h1 className="text-3xl font-semibold text-white">Admin settings</h1>
        <p className="max-w-3xl text-sm text-slate-300">
          Manage platform-wide controls, including the merchant payment instructions and subscription review flow.
        </p>
      </div>

      <AdminPanel>
        <AdminSectionHeader
          eyebrow="Payments"
          title="Merchant subscription payments"
          description="Edit the live payment instructions and review screenshots submitted by merchants."
          action={
            <Link href={"/admin/settings/payments" as any} className="rounded-full bg-[#D6A74C] px-4 py-2 text-sm font-semibold text-[#07111B] transition hover:opacity-90">
              Open payment settings
            </Link>
          }
        />
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-700/40 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Editable values</p>
            <p className="mt-2 text-sm text-white">WhatsApp, RedotPay UID, BaridiMob account, and monthly pricing.</p>
          </div>
          <div className="rounded-2xl border border-slate-700/40 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Merchant flow</p>
            <p className="mt-2 text-sm text-white">Merchants submit payment screenshots from their dashboard payment page.</p>
          </div>
          <div className="rounded-2xl border border-slate-700/40 bg-slate-800/40 p-4">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-400">Audit trail</p>
            <p className="mt-2 text-sm text-white">Updates and approvals are written to the existing audit log table.</p>
          </div>
        </div>
      </AdminPanel>
    </div>
  );
}