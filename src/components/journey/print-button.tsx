"use client";

import { buttonSecondary } from "./styles";

/**
 * Opens the browser's print dialog. Choosing "Save as PDF" there makes a file the customer can keep
 * or send on; no server work or stored copy is involved, and the page's print styles leave out the
 * site menu and the action buttons. The button itself is not printed.
 */
export function PrintButton({ children = "Print or save as PDF" }: { children?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={`${buttonSecondary} print:hidden`}>
      {children}
    </button>
  );
}
