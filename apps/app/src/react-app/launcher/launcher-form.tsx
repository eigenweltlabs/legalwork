import { useLayoutEffect, useRef, type ReactNode } from "react";
import { isMacPlatform } from "@/app/utils";
import { t } from "@/i18n";
import { handleLauncherFocusKey, launcherControls } from "./launcher-focus";
import { isComposingKeyEvent } from "./launcher-keyboard";

/** A temporary editor owns its keyboard focus until Save or Back returns to the list. */
export function LauncherForm({ title, busy, onClose, onSubmit, children }: {
  title: string; busy: boolean; onClose: () => void; onSubmit: () => void; children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const lastControl = useRef<HTMLElement | null>(null);
  const wasBusy = useRef(false);
  useLayoutEffect(() => {
    if (busy) form.current?.focus();
    else if (wasBusy.current) (lastControl.current ?? launcherControls(form.current)[0])?.focus();
    wasBusy.current = busy;
  }, [busy]);
  return <form ref={form} tabIndex={-1} className="launcher-create-form" aria-label={title} aria-busy={busy}
    onFocusCapture={event => { if (event.target !== form.current && form.current?.contains(event.target)) { lastControl.current = event.target; event.target.scrollIntoView({ block: "nearest" }); } }}
    onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(); }}
    onKeyDown={event => {
      if (event.defaultPrevented || isComposingKeyEvent(event)) return;
      event.stopPropagation();
      // Portalled dropdowns own Escape, Enter and Tab until they close.
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
      if (busy) { if (["Tab", "Enter", "Escape"].includes(event.key)) event.preventDefault(); return; }
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      else if ((isMacPlatform() ? event.metaKey : event.ctrlKey) && event.key === "Enter") {
        event.preventDefault(); if (!event.repeat) event.currentTarget.requestSubmit();
      } else if (event.key === "Enter" && event.repeat) event.preventDefault();
      else handleLauncherFocusKey(event, form.current);
    }}>
    <div className="launcher-form-heading"><strong>{title}</strong><span><kbd>Tab</kbd> {t("launcher.keyboard.fields")}</span></div>
    {children}
  </form>;
}

export function LauncherSubmitHint() { return <kbd>{isMacPlatform() ? "⌘" : "Ctrl"}↵</kbd>; }
