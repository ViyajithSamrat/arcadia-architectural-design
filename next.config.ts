import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  images: {
    // Smaller files for the landing photographs; next/image negotiates the format per browser.
    formats: ["image/avif", "image/webp"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Security headers on every page and route except Next's own static files and optimised images
  // (the image optimiser sends its own restrictive policy). The CSP is production only and is an
  // interim baseline that still allows inline scripts: see src/lib/security/headers.ts.
  async headers() {
    return [
      {
        source: "/((?!_next/static|_next/image).*)",
        headers: buildSecurityHeaders(process.env),
      },
    ];
  },
};

export default nextConfig;
