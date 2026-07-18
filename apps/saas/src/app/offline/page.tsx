"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/client";

export default function OfflinePage() {
  const { t } = useI18n();
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const updateOnlineState = () => setOnline(window.navigator.onLine);
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);

    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F4F6F5] px-6">
      <div className="text-center">
        <div className="mb-6 flex justify-center">
          <svg
            className="h-24 w-24 text-slate-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M8.111 16.251a.75.75 0 0 0 .75.75h6.278a.75.75 0 0 0 .75-.75M12 20.25A8.25 8.25 0 1 0 3.75 12"
            />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-slate-900">{t("offline.title")}</h1>
        <p className="mt-2 text-slate-600">
          {t("offline.subtitle")}
        </p>
        <p className="mt-4 text-sm text-slate-500">
          {t("offline.hint")}
        </p>
        <button
          onClick={() => window.location.reload()}
          disabled={!online}
          className="mt-8 rounded-lg bg-[#0B3D2E] px-6 py-2 text-sm font-semibold text-white transition hover:bg-[#083a28]"
        >
          {online ? t("offline.retry") : t("offline.waiting")}
        </button>
      </div>
    </div>
  );
}
