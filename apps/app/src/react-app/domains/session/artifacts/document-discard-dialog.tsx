import { useSyncExternalStore } from "react";
import { t } from "@/i18n";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { getDocumentDiscardPrompt, resolveDocumentDiscardPrompt, subscribeDocumentDiscardPrompt } from "./docx-document-state";

export function DocumentDiscardDialog() {
  const prompt = useSyncExternalStore(subscribeDocumentDiscardPrompt, getDocumentDiscardPrompt, () => null);
  return <ConfirmModal open={Boolean(prompt)} variant="danger"
    title={t("document_discard.title")}
    message={t("document_discard.body", { names: prompt?.names.join(", ") ?? "" })}
    confirmLabel={t("document_discard.confirm")} cancelLabel={t("common.cancel")}
    onConfirm={() => resolveDocumentDiscardPrompt(true)} onCancel={() => resolveDocumentDiscardPrompt(false)} />;
}
