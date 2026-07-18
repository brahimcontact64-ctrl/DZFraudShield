"use client";

import { useEffect } from "react";
import { PWA_SW_VERSION } from "@/lib/pwa/version";

export function PwaBootstrap() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(PWA_SW_VERSION)}`)
      .then(async (registration) => {
        const installed = window.matchMedia("(display-mode: standalone)").matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
        fetch("/api/v1/pwa/install-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installed }),
          cache: "no-store",
        }).catch(() => {
          // noop
        });

        if ("sync" in registration) {
          try {
            const syncRegistration = registration as ServiceWorkerRegistration & {
              sync?: { register: (tag: string) => Promise<void> };
            };
            await syncRegistration.sync?.register("dzfs-refresh-notifications");
          } catch {
            // noop
          }
        }
      })
      .catch(() => {
        // noop: PWA bootstrap should not break the app shell.
      });

    const handleMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "REFRESH_NOTIFICATIONS") {
        window.dispatchEvent(new CustomEvent("dzfs:pwa-refresh"));
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, []);

  return null;
}
