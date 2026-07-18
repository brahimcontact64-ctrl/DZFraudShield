import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaBootstrap } from "@/components/pwa/pwa-bootstrap";
import { getI18nServer } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "DZ Fraud Shield",
  description: "Fraud protection SaaS for Algerian WooCommerce merchants",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.svg", type: "image/svg+xml" },
      { url: "/icon-512.svg", type: "image/svg+xml" }
    ],
    apple: "/apple-touch-icon.svg"
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "DZ Fraud Shield"
  }
};

export const viewport: Viewport = {
  themeColor: "#0B3D2E",
  // Required for env(safe-area-inset-*) to work on iOS notch / home indicator.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir } = await getI18nServer();

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen antialiased">
        <PwaBootstrap />
        {children}
      </body>
    </html>
  );
}
