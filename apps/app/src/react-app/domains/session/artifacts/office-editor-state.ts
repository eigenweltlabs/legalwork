import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/sonner";

export type OfficeEditorApi = { save: () => Promise<boolean>; getBuffer: () => Promise<ArrayBuffer | null> };
export type OfficeEditorProps = {
  name: string;
  content: ArrayBuffer;
  readOnly?: boolean;
  onSave: (buffer: ArrayBuffer) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  apiRef: RefObject<OfficeEditorApi | null>;
};

export function useOfficeEditor(props: OfficeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const serialize = useRef<(() => Promise<ArrayBuffer>) | null>(null);
  const afterSave = useRef<(() => void) | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const revision = useRef(0);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useCallback(() => {
    if (latest.current.readOnly) return;
    revision.current++;
    latest.current.onDirtyChange(true);
  }, []);
  useEffect(() => {
    const getBuffer = async () => {
      if (!serialize.current || busy.current) return null;
      busy.current = true; setSaving(true); latest.current.onSavingChange?.(true);
      try {
        if (document.activeElement instanceof HTMLElement && host.current?.contains(document.activeElement)) document.activeElement.blur();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return await serialize.current();
      } finally { busy.current = false; setSaving(false); latest.current.onSavingChange?.(false); }
    };
    const save = async () => {
      if (latest.current.readOnly || busy.current || !serialize.current) return false;
      busy.current = true; setSaving(true); latest.current.onSavingChange?.(true);
      try {
        if (document.activeElement instanceof HTMLElement && host.current?.contains(document.activeElement)) document.activeElement.blur();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const version = revision.current;
        const buffer = await serialize.current();
        await latest.current.onSave(buffer);
        if (version === revision.current) { afterSave.current?.(); latest.current.onDirtyChange(false); }
        return true;
      } finally { busy.current = false; setSaving(false); latest.current.onSavingChange?.(false); }
    };
    const api = { save, getBuffer };
    props.apiRef.current = api;
    const element = host.current;
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopImmediatePropagation();
        void save().then((ok) => { if (ok) toast.success("Saved"); }).catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "Could not save. Your edits are still here."));
      }
    };
    element?.addEventListener("keydown", keydown, true);
    return () => { if (props.apiRef.current === api) props.apiRef.current = null; element?.removeEventListener("keydown", keydown, true); };
  }, [props.apiRef]);
  return { host, serialize, afterSave, changed, saving, error, setError };
}
