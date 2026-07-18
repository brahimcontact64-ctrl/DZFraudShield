"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/client";

type DeferredInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISSED_KEY = "dzfs_ios_install_hint_dismissed";

function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={22}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      width={22}
    >
      <path d="M8.5 8.5L12 5l3.5 3.5" />
      <line x1="12" x2="12" y1="5" y2="15" />
      <path d="M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4" />
    </svg>
  );
}

export function InstallPrompt() {
  const { t } = useI18n();
  const [deferredPrompt, setDeferredPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [showIosSheet, setShowIosSheet] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  // Required for createPortal — document is only available client-side.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

    // iPadOS 13+ reports "MacIntel" in navigator.platform — detect via touch points.
    const iosDetected =
      /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);

    const dismissed = window.localStorage.getItem(DISMISSED_KEY) === "1";

    setIsInstalled(standalone);
    setIsIos(iosDetected);
    setIsDismissed(dismissed);

    const onInstalled = () => {
      setIsInstalled(true);
      setShowIosSheet(false);
      window.localStorage.setItem(DISMISSED_KEY, "1");
      fetch("/api/v1/pwa/install-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installed: true }),
        cache: "no-store",
      }).catch(() => {});
    };

    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as DeferredInstallPrompt);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  const canPromptInstall = Boolean(deferredPrompt) && !isInstalled;

  // Already installed — nothing to show.
  if (isInstalled) return null;

  // Android / Chrome: a native install prompt is available.
  if (canPromptInstall) {
    return (
      <div className="flex items-center rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
        <button
          className="rounded-md bg-[#D6A74C] px-2.5 py-1 text-[11px] font-semibold text-[#0F1B14] transition hover:bg-[#c69634]"
          onClick={async () => {
            if (!deferredPrompt) return;
            await deferredPrompt.prompt();
            const choice = await deferredPrompt.userChoice;
            if (choice.outcome === "accepted") {
              setDeferredPrompt(null);
            }
          }}
          type="button"
        >
          {t("pwa.install")}
        </button>
      </div>
    );
  }

  // iOS Safari: beforeinstallprompt never fires — guide the user manually.
  // If the user has permanently dismissed the hint, hide the button entirely.
  if (isIos && !isDismissed) {
    // ROOT CAUSE FIX: the modal must be portalled to document.body.
    //
    // The header that contains this component has `backdrop-blur` which applies
    // backdrop-filter: blur(). On iOS Safari, any position:fixed child of a
    // backdrop-filter ancestor is positioned relative to that ancestor (not the
    // viewport). Without the portal the bottom sheet would render 96px above
    // the bottom of the 56px header — completely off-screen — making it appear
    // as if the button does nothing. createPortal moves the element to
    // document.body, escaping the backdrop-filter stacking context entirely.
    const sheet =
      mounted && showIosSheet
        ? createPortal(
            <div
              aria-label={t("pwa.installTitle")}
              aria-modal="true"
              className="fixed inset-x-3 bottom-24 z-[200] rounded-2xl border border-slate-200 bg-white shadow-2xl"
              role="dialog"
            >
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#F4F6F5] text-[#0B3D2E]">
                    <ShareIcon />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{t("pwa.installTitle")}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{t("pwa.installDesc")}</p>
                  </div>
                </div>

                <ol className="mt-4 space-y-2.5">
                  <li className="flex items-start gap-2.5 text-xs text-slate-700">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0B3D2E] text-[10px] font-bold text-white">1</span>
                    <span>{t("pwa.iosStep1")}</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-xs text-slate-700">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0B3D2E] text-[10px] font-bold text-white">2</span>
                    <span>{t("pwa.iosStep2")}</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-xs text-slate-700">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0B3D2E] text-[10px] font-bold text-white">3</span>
                    <span>{t("pwa.iosStep3")}</span>
                  </li>
                </ol>

                <p className="mt-3.5 rounded-lg bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-700">
                  {t("pwa.iosPushNote")}
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
                <button
                  className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  onClick={() => setShowIosSheet(false)}
                  type="button"
                >
                  {t("pwa.dismiss")}
                </button>
                <button
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    window.localStorage.setItem(DISMISSED_KEY, "1");
                    setIsDismissed(true);
                    setShowIosSheet(false);
                  }}
                  type="button"
                >
                  {t("pwa.hideInstallHint")}
                </button>
              </div>
            </div>,
            document.body
          )
        : null;

    return (
      <>
        <div className="flex items-center rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
          <button
            className="rounded-md bg-[#D6A74C] px-2.5 py-1 text-[11px] font-semibold text-[#0F1B14] transition hover:bg-[#c69634]"
            onClick={() => setShowIosSheet(true)}
            type="button"
          >
            {t("pwa.install")}
          </button>
        </div>
        {sheet}
      </>
    );
  }

  // Desktop, non-iOS without beforeinstallprompt, or dismissed — nothing to show.
  return null;
}
