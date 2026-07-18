"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { formatDateTime } from "@/lib/format-date";

type NotificationItem = {
  id: string;
  event: string;
  message: string;
  provider: string | null;
  level: "info" | "warning" | "critical";
  createdAt: string;
  resolved: boolean;
};

export function NotificationCenterClient({ initialItems }: { initialItems: NotificationItem[] }) {
  const { t } = useI18n();
  const [items, setItems] = useState(initialItems);

  async function markAllRead() {
    await fetch("/api/v1/merchant/notifications?action=mark-all-read", { method: "PATCH" });
    setItems((current) => current.map((item) => ({ ...item, resolved: true })));
  }

  async function markRead(id: string, read: boolean) {
    await fetch(`/api/v1/merchant/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read }),
    });

    setItems((current) => current.map((item) => (item.id === id ? { ...item, resolved: read } : item)));
  }

  async function remove(id: string) {
    await fetch(`/api/v1/merchant/notifications/${id}`, { method: "DELETE" });
    setItems((current) => current.filter((item) => item.id !== id));
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" onClick={markAllRead} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
          {t("notifications.center.markAllRead")}
        </button>
      </div>
      {items.map((item) => (
        <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">{item.event}</p>
              <p className="mt-1 text-sm text-slate-600">{item.message}</p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{item.provider ?? t("dashboard.notifications.system")}</p>
              <p className="mt-1 text-xs text-slate-500">{formatDateTime(item.createdAt)}</p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => markRead(item.id, !item.resolved)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              {item.resolved ? t("notifications.center.markUnread") : t("notifications.center.markRead")}
            </button>
            <button
              type="button"
              onClick={() => remove(item.id)}
              className="rounded-md border border-rose-200 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
            >
              {t("notifications.center.delete")}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
