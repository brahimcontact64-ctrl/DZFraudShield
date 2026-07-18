"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BellIcon,
  LayoutIcon,
  MenuIcon,
  TruckIcon,
} from "@/components/ui/icons";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { NotificationPermission } from "@/components/pwa/notification-permission";
import { ConnectionStatus } from "@/components/pwa/connection-status";
import { UpdateAvailable } from "@/components/pwa/update-available";
import { useI18n } from "@/lib/i18n/client";

const nav: ReadonlyArray<{ href: string; key: string; Icon: (props: { className?: string; size?: number }) => JSX.Element; exact?: boolean }> = [
  { href: "/dashboard", key: "shell.overview", Icon: LayoutIcon, exact: true },
  { href: "/dashboard/orders", key: "shell.orders", Icon: LayoutIcon },
  { href: "/dashboard/shipments", key: "shell.shipments", Icon: TruckIcon },
  { href: "/dashboard/more", key: "shell.more", Icon: MenuIcon },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  useEffect(() => {
    let mounted = true;

    async function loadNotificationCount() {
      try {
        const response = await fetch("/api/v1/merchant/notifications", { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { unread?: number };
        if (mounted) {
          setUnreadNotifications(Number(payload.unread ?? 0));
        }
      } catch {
        // Silent fail to avoid blocking dashboard shell rendering.
      }
    }

    void loadNotificationCount();
    const timer = window.setInterval(loadNotificationCount, 30_000);

    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  function isActive(href: string, exact?: boolean) {
    if (!pathname) return false;

    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
  }

  const title = nav.find((item) => isActive(item.href, item.exact))?.key;

  return (
    <div className="min-h-screen bg-[#F4F6F5] pb-24">
      <UpdateAvailable />
      <ConnectionStatus />
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#D6A74C]">DZ Fraud Shield</p>
            <p className="text-sm font-semibold text-slate-900">{title ? t(title) : t("app.codOps")}</p>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <NotificationPermission />
            <InstallPrompt />
            <Link href={"/dashboard/notifications" as any} className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700">
              <BellIcon size={16} />
              {unreadNotifications > 0 ? (
                <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-rose-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
                  {unreadNotifications > 99 ? "99+" : unreadNotifications}
                </span>
              ) : null}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto grid max-w-6xl grid-cols-4">
          {nav.map(({ href, key, Icon, ...rest }) => {
            const active = isActive(href, (rest as any).exact);
            return (
              <Link
                key={href}
                href={href as any}
                className={`flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-semibold ${active ? "text-brand" : "text-slate-500"}`}
              >
                <Icon size={17} />
                <span>{t(key)}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
