import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DZ Fraud Shield",
    short_name: "DZ Shield",
    description: "Mobile-first fraud and COD operations workspace for Algerian WooCommerce merchants.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#F4F6F5",
    theme_color: "#0B3D2E",
    orientation: "portrait",
    icons: [
      {
        src: "/icon-192.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any"
      },
      {
        src: "/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any"
      },
      {
        src: "/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable"
      },
      {
        src: "/apple-touch-icon.svg",
        sizes: "180x180",
        type: "image/svg+xml"
      }
    ]
  };
}
