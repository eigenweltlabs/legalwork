import { useEffect, useRef, useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import { t } from "@/i18n";
import { DirectoryDialog } from "./twenty-controls";

/** One decision for the exact entries selected, never a reusable permission. */
export function useTimeEntryRemoval() {
  const [entries, setEntries] = useState<readonly string[] | null>(null);
  const pending = useRef<((allowed: boolean) => void) | null>(null);
  useEffect(() => () => {
    pending.current?.(false);
    pending.current = null;
  }, []);
  const decide = (allowed: boolean) => {
    pending.current?.(allowed);
    pending.current = null;
    setEntries(null);
  };
  return {
    confirm: (names: readonly string[]) => {
      if (pending.current || !names.length) return Promise.resolve(false);
      setEntries(names);
      return new Promise<boolean>(resolve => { pending.current = resolve; });
    },
    dialog: entries && <DirectoryDialog title={t("timesheets.remove.title")} onClose={() => decide(false)}>
      <p>{t("timesheets.remove.hint", { count: entries.length })}</p>
      <ul className="max-h-48 overflow-auto">{entries.map((name, index) => <li key={index}>{name}</li>)}</ul>
      <div className="bo-modal-footer">
        <Button size="sm" variant="ghost" autoFocus onClick={() => decide(false)}>{t("common.cancel")}</Button>
        <Button size="sm" color="danger" variant="solid" onClick={() => decide(true)}>{t("timesheets.remove.confirm")}</Button>
      </div>
    </DirectoryDialog>,
  };
}
