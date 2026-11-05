import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { getDocumentDiscardPrompt, getUnsavedDocuments, resolveDocumentDiscardPrompt, settleUnsavedDocuments, subscribeDocumentDiscardPrompt } from "./docx-document-state";

type ShutdownAction = "close" | "restart";
declare global {
  interface Window {
    __LEGALWORK_SHUTDOWN__?: { hasUnsavedChanges: () => boolean; request: (action: ShutdownAction) => Promise<boolean> };
  }
}

export function DocumentDiscardDialog() {
  const prompt = useSyncExternalStore(subscribeDocumentDiscardPrompt, getDocumentDiscardPrompt, () => null);
  return <><ShutdownDialog /><ConfirmModal open={Boolean(prompt)} variant="danger"
    title={t("document_discard.title")}
    message={t("document_discard.body", { names: prompt?.names.join(", ") ?? "" })}
    confirmLabel={t("document_discard.confirm")} cancelLabel={t("common.cancel")}
    onConfirm={() => resolveDocumentDiscardPrompt(true)} onCancel={() => resolveDocumentDiscardPrompt(false)} /></>;
}

export function ShutdownDialog() {
  const navigate = useNavigate();
  const [action, setAction] = useState<ShutdownAction | null>(null);
  const [working, setWorking] = useState<"save" | "discard" | null>(null);
  const busy = working !== null;
  const [failed, setFailed] = useState(false);
  const pending = useRef<{ promise: Promise<boolean>; resolve: (approved: boolean) => void } | null>(null);
  const finish = (approved: boolean) => {
    pending.current?.resolve(approved);
    pending.current = null;
    setAction(null);
    setFailed(false);
  };
  useEffect(() => {
    const bridge = {
      hasUnsavedChanges: () => getUnsavedDocuments().length > 0,
      request: (next: ShutdownAction) => {
        if (pending.current) return pending.current.promise;
        if (!getUnsavedDocuments().length) return Promise.resolve(true);
        let resolve = (_approved: boolean) => {};
        const promise = new Promise<boolean>(done => { resolve = done; });
        pending.current = { promise, resolve };
        setFailed(false);
        setAction(next);
        return promise;
      },
    };
    window.__LEGALWORK_SHUTDOWN__ = bridge;
    return () => {
      if (window.__LEGALWORK_SHUTDOWN__ === bridge) delete window.__LEGALWORK_SHUTDOWN__;
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, []);
  const documents = action ? getUnsavedDocuments() : [];
  const hidden = documents.find(item => item.actions?.open && !item.actions.isVisible?.());
  const settle = async (choice: "save" | "discard") => {
    setWorking(choice);
    setFailed(false);
    try {
      if (await settleUnsavedDocuments(choice)) finish(true);
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setWorking(null); }
  };
  return <Dialog open={action !== null} onOpenChange={open => { if (!open && !busy) finish(false); }}>
    <DialogContent showCloseButton={!busy} className="sm:max-w-[44rem]">
      <DialogHeader>
        <DialogTitle>{t(action === "restart" ? "shutdown.restart_title" : "shutdown.close_title")}</DialogTitle>
        <DialogDescription>{t("shutdown.description")}</DialogDescription>
      </DialogHeader>
      <ul className="max-h-48 space-y-1 overflow-y-auto break-words text-sm">{documents.map(item => <li key={item.key}>{item.name}</li>)}</ul>
      {failed && <p role="alert" className="text-sm text-destructive">{t("shutdown.failed")}</p>}
      <DialogFooter className="flex-row flex-nowrap items-center [&>button]:h-auto [&>button]:min-h-9 [&>button]:min-w-0 [&>button]:shrink [&>button]:whitespace-normal [&>button]:py-2">
        {hidden && <Button className="mr-auto" variant="outline" disabled={busy} onClick={() => { finish(false); hidden.actions?.open?.(navigate); }}>{t("shutdown.open_file")}</Button>}
        <Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={() => void settle("discard")}>{t(action === "restart" ? "shutdown.discard_restart" : "shutdown.discard_close")}</Button>
        <Button disabled={busy} onClick={() => void settle("save")}>{working === "save" ? t("common.saving") : t(action === "restart" ? "shutdown.save_restart" : "shutdown.save_close")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
