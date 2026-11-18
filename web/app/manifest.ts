import type { MetadataRoute } from "next";
import { THEME_CANVAS } from "@/lib/theme";

/**
 * Lets a phone or a desktop browser install the portal as an app, which they offer over HTTPS only. The PNGs are
 * app/icon.svg; the maskable one and app/apple-icon.png without its rounded corners, which the phone cuts itself.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Workspace Portal",
    short_name: "Portal",
    start_url: "/",
    display: "standalone",
    background_color: THEME_CANVAS.dark,
    theme_color: THEME_CANVAS.dark,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
