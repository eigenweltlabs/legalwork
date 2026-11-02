import { registerDocumentShutdown, registerUnsavedDocument } from '../session/artifacts/docx-document-state';

export type MailComposeShutdownState = {
  saving: boolean; pending: boolean; saveError: boolean; recovered: boolean;
  invalid: boolean; uploading: boolean; sending: boolean; switching: boolean;
};

export function registerMailComposeShutdown({ key, name, read, save, close }: {
  key: string; name: string; read: () => MailComposeShutdownState;
  save: () => Promise<void>; close: () => void;
}) {
  let discarded = false;
  const busy = () => { const state = read(); return state.saving || state.uploading || state.sending || state.switching; };
  const isDirty = () => {
    const state = read();
    return !discarded && (state.invalid || state.uploading || state.sending || state.switching ||
      !state.recovered && (state.saving || state.pending || state.saveError));
  };
  const unregister = registerUnsavedDocument(key, name, isDirty, undefined, false, { scopedOnly: true });
  const unregisterActions = registerDocumentShutdown(key, {
    isBusy: busy,
    save: async () => { if (read().invalid || busy()) return false; await save(); return !isDirty(); },
    discard: () => { if (busy()) return; discarded = true; close(); },
  });
  return { isDirty, dispose: () => { unregisterActions(); unregister(); } };
}
