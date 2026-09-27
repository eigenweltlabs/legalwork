// Shell panel open-state (command palette, session search, terminal) plus the
// global keyboard shortcuts that toggle them. Extracted verbatim from
// session-route.tsx.
import { useEffect, useEffectEvent, useState } from "react";

export type UseShellShortcutsInput = {
  canCreateChat: boolean;
  workspaceId: string;
  onCreateChat: (workspaceId: string) => void | Promise<void>;
  onNextSessionTab?: () => void;
  onPrevSessionTab?: () => void;
};

export function useShellShortcuts(input: UseShellShortcutsInput) {
  const { canCreateChat, workspaceId, onCreateChat, onNextSessionTab, onPrevSessionTab } = input;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Global shortcuts:
  //   Cmd/Ctrl+N        -> new chat in selected workspace
  //   Cmd/Ctrl+K        -> toggle command palette
  //   Cmd/Ctrl+J        -> toggle terminal panel (matches VS Code)
  //   Cmd/Ctrl+Shift+F  -> search every session (titles + messages)
  //   Cmd/Ctrl+T        -> next session tab
  //   Cmd/Ctrl+Shift+T  -> previous session tab
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.isComposing) return;
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

    const target = event.target as HTMLElement | null;
    const inEditable =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const key = event.key?.toLowerCase();
    if (key === "n" && !inEditable) {
      event.preventDefault();
      if (canCreateChat && workspaceId) {
        void onCreateChat(workspaceId);
      }
      return;
    }
    if (key === "k") {
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
    // App search owns Cmd/Ctrl+K before embedded editors can insert a link.
    // Other shortcuts keep their existing bubbling behavior.
    const captureSearch = (event: KeyboardEvent) => {
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
