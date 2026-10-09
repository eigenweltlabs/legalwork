import { Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Use the macOS window-control strip as a clear way out of expanded documents. */
export function ExpandedDocumentBar({ label, onRestore }: { label: string; onRestore: () => void }) {
  return <div data-expanded-document-bar className="titlebar-drag fixed inset-x-0 top-0 z-50 hidden h-11 items-center justify-center border-b border-border/70 bg-background px-24 mac:flex">
    <Button variant="secondary" size="sm" className="titlebar-no-drag" onClick={onRestore}>
      <Minimize2 />{label}
    </Button>
  </div>;
}
