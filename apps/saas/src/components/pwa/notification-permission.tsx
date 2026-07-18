"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";

type PermissionState = "unsupported" | "default" | "granted" | "denied";
const PROMPT_ONCE_KEY = "dzfs_push_prompt_once_v1";

function base64ToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

let cachedVapidKey: string | null | undefined;
async function fetchVapidPublicKey(): Promise<string | null> {
  if (cachedVapidKey !== undefined) return cachedVapidKey;
  try {
    const res = await fetch("/api/v1/pwa/push/config", { cache: "no-store" });
    if (!res.ok) { cachedVapidKey = null; return null; }
    const data = await res.json() as { vapidPublicKey?: string };
    cachedVapidKey = data.vapidPublicKey ?? null;
    return cachedVapidKey;
  } catch {
    cachedVapidKey = null;
    return null;
  }
}

async function syncSubscription(subscription: PushSubscription | null) {
  if (!subscription) {
    return;
  }

  await fetch("/api/v1/pwa/push/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subscription.toJSON()),
    cache: "no-store",
  });
}

async function disableSubscription(endpoint: string) {
  await fetch("/api/v1/pwa/push/unsubscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ endpoint }),
    cache: "no-store",
  });
}

async function patchPermissionState(permissionState: "default" | "granted" | "denied") {
  await fetch("/api/v1/merchant/notification-settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      permissionState,
      permissionPromptedAt: new Date().toISOString(),
    }),
    cache: "no-store",
  });
}

async function runVerificationProbe() {
  await fetch("/api/v1/pwa/push/verify", {
    method: "POST",
    cache: "no-store",
  });
}

export function NotificationPermission() {
  const { t } = useI18n();
  const [permission, setPermission] = useState<PermissionState>("unsupported");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const hasPushSupport = useMemo(() => typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window, []);

  useEffect(() => {
    if (!hasPushSupport) {
      setPermission("unsupported");
      return;
    }

    setPermission(Notification.permission as PermissionState);
  }, [hasPushSupport]);

  useEffect(() => {
    if (!hasPushSupport || permission !== "default") {
      return;
    }

    if (window.localStorage.getItem(PROMPT_ONCE_KEY) === "1") {
      return;
    }

    const timeout = window.setTimeout(async () => {
      window.localStorage.setItem(PROMPT_ONCE_KEY, "1");
      const result = await Notification.requestPermission();
      const next = result as PermissionState;
      setPermission(next);
      if (next === "granted" || next === "denied" || next === "default") {
        await patchPermissionState(next);
      }

      if (next !== "granted") {
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const vapidPublicKey = await fetchVapidPublicKey();
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription && vapidPublicKey) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
        });
      }

      await syncSubscription(subscription);
      setIsSubscribed(Boolean(subscription));
      await runVerificationProbe();
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [hasPushSupport, permission]);

  useEffect(() => {
    if (!hasPushSupport || permission !== "granted") {
      setIsSubscribed(false);
      return;
    }

    navigator.serviceWorker.ready
      .then(async (registration) => {
        const subscription = await registration.pushManager.getSubscription();
        setIsSubscribed(Boolean(subscription));
        // Re-sync the current subscription on every mount. This handles the
        // case where the browser silently renewed the push endpoint (e.g. after
        // reinstall or subscription rotation). The server upsert is idempotent,
        // so re-syncing an unchanged endpoint just refreshes last_seen_at.
        if (subscription) {
          await syncSubscription(subscription).catch(() => {});
        }
      })
      .catch(() => {
        setIsSubscribed(false);
      });
  }, [hasPushSupport, permission]);

  if (permission === "unsupported") {
    return null;
  }

  if (permission === "granted") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5">
        <span className="text-xs font-semibold text-emerald-700">{isSubscribed ? t("pwa.pushEnabled") : t("pwa.pushReady")}</span>
        {isSubscribed ? (
          <button
            className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onClick={async () => {
              try {
                setBusy(true);
                const registration = await navigator.serviceWorker.ready;
                const subscription = await registration.pushManager.getSubscription();

                if (subscription) {
                  await disableSubscription(subscription.endpoint);
                  await subscription.unsubscribe();
                }

                setIsSubscribed(false);
                await patchPermissionState("denied");
              } finally {
                setBusy(false);
              }
            }}
            type="button"
          >
            {t("pwa.disablePush")}
          </button>
        ) : null}
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <span className="rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700" title={t("pwa.pushBlockedHelp")}>
        {t("pwa.pushBlocked")}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
      <span className="hidden text-[11px] font-medium text-slate-500 md:inline">{t("pwa.enableAlerts")}</span>
      <button
        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
        onClick={async () => {
          window.localStorage.setItem(PROMPT_ONCE_KEY, "1");
          const result = await Notification.requestPermission();
          setPermission(result as PermissionState);
          if (result === "granted" || result === "denied" || result === "default") {
            await patchPermissionState(result as "default" | "granted" | "denied");
          }

          if (result !== "granted") {
            return;
          }

          const registration = await navigator.serviceWorker.ready;
          const vapidPublicKey = await fetchVapidPublicKey();
          let subscription = await registration.pushManager.getSubscription();

          if (!subscription && vapidPublicKey) {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: base64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
            });
          }

          await syncSubscription(subscription);
          setIsSubscribed(Boolean(subscription));
          await runVerificationProbe();
        }}
        type="button"
      >
        {t("pwa.enablePush")}
      </button>
    </div>
  );
}
