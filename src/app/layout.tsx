import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Architectural AI Design",
    template: "%s | Architectural AI Design",
  },
  description:
    "Describe a new build, an interior refresh or a garden. Get a clear English brief and an itemized quote; concept designs follow after payment is checked by a person. Concept ideas, not construction drawings.",
};

export const viewport: Viewport = {
  themeColor: "#edebe6",
};

/**
 * Root layout: document shell only. The marketing page and the application pages
 * add their own chrome in their route-group layouts.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
