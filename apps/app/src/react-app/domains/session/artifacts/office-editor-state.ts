import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/sonner";

export type OfficeAgentResult = { success: boolean; data?: unknown; saved?: boolean; error?: string };
export type OfficeEditorApi = {
  save: () => Promise<boolean>;
  getBuffer: () => Promise<ArrayBuffer | null>;
  executeAgentTool: (toolName: string, args: Record<string, unknown>) => Promise<OfficeAgentResult>;
};
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
  const agentTool = useRef<((name: string, args: Record<string, unknown>) => Promise<{ data: unknown; mutated?: boolean }>) | null>(null);
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
    const executeAgentTool = async (toolName: string, args: Record<string, unknown>): Promise<OfficeAgentResult> => {
      if (toolName === "save") {
        try { const saved = await save(); return { success: saved, saved, ...(!saved ? { error: "The editor is read only, busy, or still loading." } : {}) }; }
        catch (cause) { return { success: false, saved: false, error: cause instanceof Error ? cause.message : "Save failed. The draft remains open." }; }
      }
      if (!agentTool.current || !serialize.current) return { success: false, error: "The editor is still loading." };
      if (busy.current) return { success: false, error: "The editor is busy saving. Retry after it finishes." };
      if (latest.current.readOnly && toolName !== "read") return { success: false, error: "This document is read only." };
      busy.current = true; setSaving(true); latest.current.onSavingChange?.(true);
      let mutated = false;
      try {
        if (document.activeElement instanceof HTMLElement && host.current?.contains(document.activeElement)) document.activeElement.blur();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const result = await agentTool.current(toolName, args);
        mutated = result.mutated === true;
        if (!mutated) return { success: true, data: result.data, saved: false };
        changed();
        // React-backed editors apply imperative changes on the following render.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const version = revision.current;
        await latest.current.onSave(await serialize.current());
        if (version === revision.current) { afterSave.current?.(); latest.current.onDirtyChange(false); }
        return { success: true, data: result.data, saved: true };
      } catch (cause) {
        return { success: false, saved: false, error: `${cause instanceof Error ? cause.message : "Editor tool failed."}${mutated ? " The edit remains in the open draft. Retry Save; do not repeat the edit." : ""}` };
      } finally { busy.current = false; setSaving(false); latest.current.onSavingChange?.(false); }
    };
    const api = { save, getBuffer, executeAgentTool };
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
  }, [props.apiRef, changed]);
  return { host, serialize, agentTool, afterSave, changed, saving, error, setError };
}
