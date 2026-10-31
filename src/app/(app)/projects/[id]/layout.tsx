import type { ReactNode } from "react";

/** Project pages keep a reading width: forms, the brief and the quote read best at about 70 characters. */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-4xl space-y-8">{children}</div>;
}
