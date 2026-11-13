// Shell panel open-state (command palette, session search, terminal) plus the
// global keyboard shortcuts that toggle them. Extracted verbatim from
// session-route.tsx.
import { useEffect, useEffectEvent, useState } from "react";

export type UseShellShortcutsInput = {
  onCreateChat: () => void;
  onNextSessionTab?: () => void;
  onPrevSessionTab?: () => void;
};

export function useShellShortcuts(input: UseShellShortcutsInput) {
  const { onCreateChat, onNextSessionTab, onPrevSessionTab } = input;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Global shortcuts:
  //   Cmd/Ctrl+N        -> new chat in the open project, otherwise Home
  //   Cmd/Ctrl+K        -> toggle command palette
  //   Cmd/Ctrl+J        -> toggle terminal panel (matches VS Code)
  //   Cmd/Ctrl+Shift+F  -> search every session (titles + messages)
  //   Cmd/Ctrl+T        -> next session tab
  //   Cmd/Ctrl+Shift+T  -> previous session tab
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.isComposing || event.defaultPrevented) return;
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "f") {
      event.preventDefault();
      setCommandPaletteOpen((value) => !value);
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "t") {
      event.preventDefault();
      onPrevSessionTab?.();
      return;
    }
    if (event.shiftKey || event.altKey) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    const inEditable =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const key = event.key?.toLowerCase();
    if (key === "n" && !inEditable) {
      event.preventDefault();
      onCreateChat();
      return;
    }
    if (key === "k") {
      if (target?.closest(".lw-markdown-editor [contenteditable=true]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) setCommandPaletteOpen((value) => !value);
      return;
    }
    if (key === "j") {
      event.preventDefault();
      setTerminalOpen((value) => !value);
      return;
    }
    if (key === "t") {
      event.preventDefault();
      onNextSessionTab?.();
      return;
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleGlobalShortcut(event);
    // Rich-text pages own their link shortcut; elsewhere Cmd/Ctrl+K opens search.
    const captureSearch = (event: KeyboardEvent) => {
      // Inside the launcher, Cmd/Ctrl+K opens the result's actions; the panel handles it itself.
      if (event.target instanceof HTMLElement && event.target.closest(".launcher-root")) return;
      if (!event.isComposing && event.key.toLowerCase() === "k") handleGlobalShortcut(event);
    };
    window.addEventListener("keydown", captureSearch, true);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", captureSearch, true);
      window.removeEventListener("keydown", handler);
    };
  }, []);

  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
    terminalOpen,
    setTerminalOpen,
  };
}
