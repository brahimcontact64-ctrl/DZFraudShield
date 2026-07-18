"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { PWA_SW_VERSION } from "@/lib/pwa/version";

export function UpdateAvailable() {
  const { t } = useI18n();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [notified, setNotified] = useState(false);
  const [waitingVersion, setWaitingVersion] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    let registration: ServiceWorkerRegistration | null = null;

    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        registration = reg || null;
        if (!reg) return;

        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
              setWaitingVersion(PWA_SW_VERSION);
            }
          });
        });

        reg.update().catch(() => {
          // noop
        });
      })
      .catch(() => {
        // noop
      });

    const interval = setInterval(() => {
      registration?.update().catch(() => {
        // noop
      });
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!updateAvailable || reportSent === true) {
      return;
    }

    fetch("/api/v1/pwa/update/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "detected", toVersion: waitingVersion ?? PWA_SW_VERSION }),
      cache: "no-store",
    }).catch(() => {
      // noop
    });
    setReportSent(true);
  }, [reportSent, updateAvailable, waitingVersion]);

  useEffect(() => {
    if (!updateAvailable || notified) {
      return;
    }

    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    const notification = new Notification(t("notifications.pwaUpdate.title"), {
      body: t("notifications.pwaUpdate.body"),
      icon: "/icon-192.svg",
      badge: "/icon-192.svg",
      data: { url: "/dashboard" },
    });

    notification.onclick = () => {
      window.focus();
      window.location.href = "/dashboard";
      notification.close();
    };

    setNotified(true);
  }, [notified, t, updateAvailable]);

  if (!updateAvailable) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-900">
      <div className="flex items-center justify-between">
        <span>{t("pwa.newVersion")}</span>
        <button
          onClick={async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            if (!registration) {
              return;
            }

            const onControllerChange = () => {
              fetch("/api/v1/pwa/update/events", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "applied", toVersion: waitingVersion ?? PWA_SW_VERSION }),
                cache: "no-store",
              }).finally(() => {
                window.location.reload();
              });
            };

            navigator.serviceWorker.addEventListener("controllerchange", onControllerChange, { once: true });

            const timeout = window.setTimeout(() => {
              fetch("/api/v1/pwa/update/events", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "failed", toVersion: waitingVersion ?? PWA_SW_VERSION }),
                cache: "no-store",
              }).catch(() => {
                // noop
              });
            }, 8000);

            const waiting = registration.waiting ?? registration.installing;
            waiting?.postMessage({ type: "SKIP_WAITING" });
            await registration.update().catch(() => {
              // noop
            });

            window.setTimeout(() => window.clearTimeout(timeout), 9000);
          }}
          className="rounded px-3 py-1 font-semibold text-blue-600 transition hover:bg-blue-100"
        >
          {t("pwa.updateNow")}
        </button>
      </div>
    </div>
  );
}
