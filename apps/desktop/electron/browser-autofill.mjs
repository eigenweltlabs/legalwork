export async function prepareBrowserAutofill(tab, event, details, loadStore, visible) {
  const contents = tab.view.webContents;
  const frame = event.senderFrame;
  if (!loadStore || tab.nativeContext?.remote || event.sender !== contents || frame !== contents.mainFrame || !visible()) return null;
  if (typeof details?.document !== "string" || details.document.length > 100 || typeof details.token !== "string" || details.token.length > 100) return null;
  const rect = details.rect;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const url = contents.getURL(), generation = tab.autofillGeneration;
  const current = () => !contents.isDestroyed() && frame === contents.mainFrame && !frame.detached && contents.getURL() === url && tab.autofillGeneration === generation && visible();
  const store = await loadStore();
  const entries = await store.list(url);
  if (!current() || !entries.length) return null;
  return {
    current,
    rect,
    items: entries.map(entry => ({ id: entry.id, label: entry.label, description: entry.username })),
    async fill(id) {
      if (!entries.some(entry => entry.id === id) || !current()) return false;
      const saved = await store.get(id);
      if (!current() || !store.matchesEntryWebsite(saved, url)) return false;
      frame.send("legalwork:autofill:fill", { document: details.document, token: details.token, url, username: saved.username, password: saved.password });
      return true;
    },
  };
}
