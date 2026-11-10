import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

/** Self-hosted at build time: no font request leaves the browser. */
const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const DESCRIPTION =
  "Describe a new build, an interior refresh or a garden. Get a clear English brief and an itemized quote; concept designs follow after payment is checked by a person. Concept ideas, not construction drawings.";

/**
 * Social-card image addresses must be absolute. They resolve against the deployment's own address, the
 * same setting the sign-in origin policy uses, so no URL is written into the code.
 */
function metadataBase(): URL | undefined {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  applicationName: "ARCADIA Architectural Design",
  title: {
    default: "ARCADIA · Architectural Design",
    template: "%s | ARCADIA Architectural Design",
  },
  description: DESCRIPTION,
  // The card image is src/app/opengraph-image.png (and twitter-image.png), picked up by Next.
  openGraph: {
    type: "website",
    siteName: "ARCADIA Architectural Design",
    title: "ARCADIA · Architecture, reimagined.",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "ARCADIA · Architecture, reimagined.",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: "#182923",
};

/**
 * Root layout: document shell only. The marketing page and the application pages
 * add their own chrome in their route-group layouts.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${display.variable} ${sans.variable}`}>
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
