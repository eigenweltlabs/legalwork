import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const WorkspaceHeaderTarget = createContext<HTMLElement | null>(null);
export const PeriodControlsTarget = createContext<HTMLElement | null>(null);
export const TimekeeperControlTarget = createContext<HTMLElement | null>(null);

export function TimeHeaderContent({ slot, children }: {
  slot: typeof WorkspaceHeaderTarget;
  children: ReactNode;
}) {
  const target = useContext(slot);
  return target ? createPortal(children, target) : children;
}
