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

export const metadata: Metadata = {
  title: {
    default: "GNANI · Architectural AI Design",
    template: "%s | GNANI Architectural AI",
  },
  description:
    "Describe a new build, an interior refresh or a garden. Get a clear English brief and an itemized quote; concept designs follow after payment is checked by a person. Concept ideas, not construction drawings.",
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
