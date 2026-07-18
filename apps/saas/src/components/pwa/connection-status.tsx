"use client";

import { useEffect, useState } from "react";
import { WifiOffIcon } from "@/components/ui/icons";
import { useI18n } from "@/lib/i18n/client";

export function ConnectionStatus() {
  const { t } = useI18n();
  const [isOnline, setIsOnline] = useState(true);
  const [showStatus, setShowStatus] = useState(false);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    setShowStatus(false);

    function handleOnline() {
      setIsOnline(true);
      setShowStatus(true);
      setTimeout(() => setShowStatus(false), 3000);
    }

    function handleOffline() {
      setIsOnline(false);
      setShowStatus(true);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!showStatus && isOnline) {
    return null;
  }

  return (
    <div
      className={`fixed bottom-4 right-4 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
        isOnline
          ? "bg-emerald-50 text-emerald-700"
          : "bg-amber-50 text-amber-700"
      }`}
    >
      <div className="flex items-center gap-2">
        {!isOnline && <WifiOffIcon size={14} />}
        <span>{isOnline ? t("pwa.backOnline") : t("pwa.noConnection")}</span>
      </div>
    </div>
  );
}
