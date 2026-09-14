import { test, expect } from 'bun:test';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {value: {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key)}});
const { mailPreviewType, openMailPreview, readMailPreview } = await import('../src/react-app/domains/session/artifacts/mail-preview-source');
const { EVALS_PANEL_SESSION_ID, usePanelTabStore } = await import('../src/react-app/domains/session/panel/panel-tab-store');

test('mail previews use ephemeral panel sources and retire on access loss, replacement and tab close', () => {
  const signal = new AbortController();
  const source = {name:'synthetic.txt',bytes:new TextEncoder().encode('private fixture'),type:'text' as const,mime:'text/plain'};
  openMailPreview(source, signal.signal);
  const id = usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].activeTabId!;
  expect(readMailPreview(id)).toBe(source);
  const persisted = usePanelTabStore.persist.getOptions().partialize!(usePanelTabStore.getState());
  expect(JSON.stringify(persisted)).not.toContain('synthetic');
  expect(JSON.stringify(persisted)).not.toContain(id);
  signal.abort();
  expect(readMailPreview(id)).toBeUndefined();
  expect(usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].tabs).toHaveLength(0);
  openMailPreview(source, signal.signal);
  expect(usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].tabs).toHaveLength(0);
  const second = new AbortController();
  openMailPreview(source, second.signal);
  const first = usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].activeTabId!;
  openMailPreview(source, second.signal);
  expect(readMailPreview(first)).toBeUndefined();
  const current = usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].activeTabId!;
  usePanelTabStore.getState().closeTab(EVALS_PANEL_SESSION_ID, current);
  expect(readMailPreview(current)).toBeUndefined();
  second.abort();
});
test('supported source classification leaves unsafe or unsupported formats explicit', () => {
  expect(mailPreviewType('contract.docx')).toBe('word');
  expect(mailPreviewType('report.pdf')).toBe('pdf');
  expect(mailPreviewType('hostile.html')).toBeNull();
  expect(mailPreviewType('macro.docm')).toBeNull();
  expect(mailPreviewType('legacy.doc')).toBeNull();
});
