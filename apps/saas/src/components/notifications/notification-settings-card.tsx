"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import type { SupportedLocale } from "@/lib/i18n/config";

type TestPushState = "idle" | "sending" | "sent" | "error" | "ratelimited";

type NotificationSettings = {
  merchantId: string;
  preferredLanguage: SupportedLocale;
  enableNotifications: boolean;
  enableNewOrder: boolean;
  enableShipmentUpdates: boolean;
  enableRiskAlerts: boolean;
  permissionState: "default" | "granted" | "denied";
  permissionPromptedAt: string | null;
};

type Props = {
  initialSettings: NotificationSettings;
};

export function NotificationSettingsCard({ initialSettings }: Props) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState<NotificationSettings>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestPushState>("idle");

  useEffect(() => {
    setSettings((current) => ({ ...current, preferredLanguage: locale }));
  }, [locale]);

  const disabled = useMemo(() => !settings.enableNotifications, [settings.enableNotifications]);

  async function patchSettings(patch: Partial<NotificationSettings>) {
    try {
      setSaving(true);
      const next = { ...settings, ...patch };
      setSettings(next);
      await fetch("/api/v1/merchant/notification-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferredLanguage: next.preferredLanguage,
          enableNotifications: next.enableNotifications,
          enableNewOrder: next.enableNewOrder,
          enableShipmentUpdates: next.enableShipmentUpdates,
          enableRiskAlerts: next.enableRiskAlerts,
          permissionState: next.permissionState,
          permissionPromptedAt: next.permissionPromptedAt,
        }),
      });
    } finally {
      setSaving(false);
    }
  }

  async function sendTestPush() {
    setTestState("sending");
    try {
      const res = await fetch("/api/v1/pwa/push/test", { method: "POST", cache: "no-store" });
      if (res.status === 429) { setTestState("ratelimited"); return; }
      if (!res.ok) { setTestState("error"); return; }
      setTestState("sent");
      setTimeout(() => setTestState("idle"), 8000);
    } catch {
      setTestState("error");
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <Toggle
        label={t("notifications.settings.master")}
        checked={settings.enableNotifications}
        disabled={saving}
        onChange={(value) => patchSettings({ enableNotifications: value })}
      />
      <Toggle
        label={t("notifications.settings.newOrder")}
        checked={settings.enableNewOrder}
        disabled={saving || disabled}
        onChange={(value) => patchSettings({ enableNewOrder: value })}
      />
      <Toggle
        label={t("notifications.settings.shipmentUpdates")}
        checked={settings.enableShipmentUpdates}
        disabled={saving || disabled}
        onChange={(value) => patchSettings({ enableShipmentUpdates: value })}
      />
      <Toggle
        label={t("notifications.settings.riskAlerts")}
        checked={settings.enableRiskAlerts}
        disabled={saving || disabled}
        onChange={(value) => patchSettings({ enableRiskAlerts: value })}
      />
      {settings.permissionState === "denied" ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{t("notifications.settings.deniedHint")}</p>
      ) : null}
      {settings.permissionState === "granted" ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{t("notifications.settings.testPushTitle")}</p>
          <p className="mt-1 text-xs text-slate-500">{t("notifications.settings.testPushDesc")}</p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={testState === "sending" || testState === "sent"}
              onClick={sendTestPush}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testState === "sending"
                ? t("notifications.settings.testPushSending")
                : t("notifications.settings.testPushSend")}
            </button>
            {testState === "sent" ? (
              <span className="text-xs font-semibold text-emerald-600">{t("notifications.settings.testPushQueued")}</span>
            ) : testState === "ratelimited" ? (
              <span className="text-xs font-semibold text-amber-600">{t("notifications.settings.testPushRateLimit")}</span>
            ) : testState === "error" ? (
              <span className="text-xs font-semibold text-rose-600">{t("notifications.settings.testPushError")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2">
      <span className={disabled ? "text-slate-400" : "text-slate-700"}>{label}</span>
      <button
        type="button"
        aria-pressed={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`inline-flex h-6 w-11 items-center rounded-full transition ${checked ? "bg-emerald-500" : "bg-slate-300"} ${disabled ? "opacity-60" : ""}`}
      >
        <span className={`h-5 w-5 rounded-full bg-white transition ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </label>
  );
}
