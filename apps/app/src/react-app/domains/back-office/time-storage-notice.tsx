import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function TimeStorageNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="time-storage-notice">
      <summary><ChevronDown size={14} aria-hidden="true" />{title}</summary>
      <div className="time-storage-details">{children}</div>
    </details>
  );
}
