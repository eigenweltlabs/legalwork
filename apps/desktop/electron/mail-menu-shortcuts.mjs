/** A stalled renderer never causes a delayed reply followed by a fallback reload. */
const active = new WeakSet();
export async function dispatchMailReply(contents, replyAll, stillCurrent = () => true) {
  if (active.has(contents)) return 'handled';
  active.add(contents);
  const deadline = Date.now() + 300;
  const url = contents.getURL();
  let timer;
  try {
    const result = await Promise.race([
      contents.executeJavaScript(`(() => {
        if (!document.hasFocus() || Date.now() > ${deadline} || location.href !== ${JSON.stringify(url)}) return 'expired';
        const target = document.activeElement;
        if (!(target instanceof HTMLElement) || !target.closest('main[aria-label="Local mail"]')) return 'unused';
        if (target.closest('[aria-label="Compose message"]')) return 'handled';
        const event = new KeyboardEvent('keydown', {key:'r', bubbles:true, cancelable:true,
          metaKey:${process.platform === 'darwin'}, ctrlKey:${process.platform !== 'darwin'}, shiftKey:${replyAll === true}});
        target.dispatchEvent(event);
        return event.defaultPrevented ? 'handled' : 'unused';
      })()`),
      new Promise(resolve => { timer = setTimeout(() => resolve('expired'), 300); }),
    ]);
    return stillCurrent() && !contents.isDestroyed() && contents.getURL() === url ? result : 'expired';
  } catch { return 'expired'; }
  finally { clearTimeout(timer); active.delete(contents); }
}
