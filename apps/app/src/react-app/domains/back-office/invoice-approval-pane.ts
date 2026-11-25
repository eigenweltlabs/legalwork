import { createContext, type ReactNode } from "react";

export type InvoiceDocument = { id: string; label: string; content: ReactNode };

export type InvoiceWorkspaceActions = {
  target: HTMLElement | null;
  open: () => void;
  close: () => void;
  openDocument: (document: InvoiceDocument) => void;
  closeDocument: (id: string) => void;
};

export const InvoiceApprovalPane = createContext<InvoiceWorkspaceActions | null>(null);
