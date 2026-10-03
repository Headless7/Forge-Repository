import type { MetadataRoute } from "next";

/** Lets Forge be installed to a home screen — on iPhone and iPad, device notifications need that. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Forge Studio",
    short_name: "Forge",
    description: "Production boards and media review for Roblox studios.",
    start_url: "/",
    display: "standalone",
    background_color: "#0f0e17",
    theme_color: "#15131f",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
