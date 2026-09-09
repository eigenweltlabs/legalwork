import { EVALS_PANEL_SESSION_ID, usePanelTabStore } from '../panel/panel-tab-store';
import { useUiStateStore } from '../../../shell/ui-state-store';
import { classifyOpenTarget } from './open-target';

export type MailPreviewSource = { name: string; bytes: Uint8Array<ArrayBuffer>; type: 'pdf' | 'image' | 'text' | 'word'; mime: string };
const sources = new Map<string, MailPreviewSource>();
let retire: (() => void) | undefined;
export function readMailPreview(id: string) { return sources.get(id); }
export function mailPreviewType(name: string): MailPreviewSource['type'] | null {
  const kind = classifyOpenTarget(name, 'file');
  if (/\.docx$/i.test(name)) return 'word';
  if (kind === 'pdf' || kind === 'image') return kind;
  if (kind === 'text' || kind === 'markdown' || /\.(csv|tsv|eml)$/i.test(name)) return 'text';
  return null;
}
/** Ephemeral, verified mail bytes never enter workspace files, query caches or persisted tabs. */
export function openMailPreview(source: MailPreviewSource, signal: AbortSignal, validate?: () => Promise<void>) {
  if (signal.aborted) return;
  retire?.();
  const id = 'mail-preview:' + crypto.randomUUID();
  const session = EVALS_PANEL_SESSION_ID;
  sources.set(id, source);
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    unsubscribe();
    clearInterval(timer);
    signal.removeEventListener('abort', close);
    sources.delete(id);
    if (retire === close) retire = undefined;
    usePanelTabStore.getState().closeTab(session, id);
  };
  retire = close;
  signal.addEventListener('abort', close, { once: true });
  usePanelTabStore.getState().openTab(session, { id, type: 'artifact', label: source.name, preview: source.type, mailSourceId: id });
  if (!usePanelTabStore.getState().sessions[session]?.tabs.some(tab => tab.id === id)) { close(); return; }
  unsubscribe = usePanelTabStore.subscribe(state => {
    if (!state.sessions[session]?.tabs.some(tab => tab.id === id)) close();
  });
  let checking = false;
  if (validate) timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void validate().catch(close).finally(() => { checking = false; });
  }, 5000);
  useUiStateStore.getState().setSidePanelState(session, 'panel');
}
