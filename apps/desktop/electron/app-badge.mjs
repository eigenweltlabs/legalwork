import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** All icon badge contributors share this owner; removing Mail preserves others. */
export function createAppBadge(app, nativeImage, getWindows, platform = process.platform) {
  const counts = new Map();
  function render() {
    const count = [...counts.values()].reduce((sum, value) => sum + value, 0);
    if (platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
    if (platform === 'win32') {
      const icon = count ? nativeImage.createFromBitmap(badgeBitmap(count), { width: 32, height: 32, scaleFactor: 1 }) : null;
      for (const window of getWindows()) if (!window.isDestroyed()) window.setOverlayIcon(icon, count ? `${count} unread items` : '');
    }
  }
  return { render, set(source, count) { const next = Number.isSafeInteger(count) && count > 0 ? count : 0; if (counts.get(source) === next) return; counts.set(source, next); render(); } };
}

// Electron's nativeImage does not decode SVG. Draw a crisp, portable BGRA overlay.
export function badgeBitmap(count) {
  const digits = ['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
  const label = count > 99 ? '99+' : String(count);
  const data = Buffer.alloc(32 * 32 * 4);
  function pixel(x, y, white) { const offset = (y * 32 + x) * 4; data[offset] = white ? 255 : 45; data[offset + 1] = white ? 255 : 45; data[offset + 2] = white ? 255 : 220; data[offset + 3] = 255; }
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if ((x - 15.5) ** 2 + (y - 15.5) ** 2 <= 15.5 ** 2) pixel(x, y, false);
  const left = Math.floor((32 - (label.length * 8 - 2)) / 2);
  [...label].forEach((char, index) => { const mask = char === '+' ? '000010111010000' : digits[Number(char)]; for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (mask[y * 3 + x] === '1') for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) pixel(left + index * 8 + x * 2 + dx, 11 + y * 2 + dy, true); });
  return data;
}

export function createMailBadgeController({ service, badge, enabled = true, intervalMs = 2000 }) {
  let stopped = false, busy = false, revision = 0;
  async function refresh() {
    if (stopped || busy) return;
    const generation = revision;
    busy = true;
    try {
      const count = enabled && service.status().state === 'ready' ? await service.unreadInboxCount() : 0;
      if (!stopped && generation === revision) badge.set('mail', count);
    } catch { if (!stopped && generation === revision) badge.set('mail', 0); }
    finally { busy = false; }
  }
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref?.();
  void refresh();
  return { refresh, setEnabled(value) { enabled = value; revision++; if (!enabled) badge.set('mail', 0); void refresh(); }, stop() { stopped = true; clearInterval(timer); badge.set('mail', 0); } };
}

let preference = true;
let preferencePath;
let controller;
let writes = Promise.resolve();
export async function configureMailBadge({ app, nativeImage, BrowserWindow, service }) {
  preferencePath = join(app.getPath('userData'), 'mail-badge.json');
  try { preference = JSON.parse(await readFile(preferencePath, 'utf8')).enabled !== false; } catch { preference = true; }
  controller?.stop();
  const badge = createAppBadge(app, nativeImage, () => BrowserWindow.getAllWindows());
  const created = () => badge.render();
  app.on('browser-window-created', created);
  controller = createMailBadgeController({ service, badge, enabled: preference });
  const active = controller;
  const stop = service.stop.bind(service);
  service.stop = async () => { active.stop(); app.removeListener('browser-window-created', created); if (controller === active) controller = undefined; await stop(); };
}
export function getMailBadgeEnabled() { return preference; }
export async function setMailBadgeEnabled(enabled) {
  if (typeof enabled !== 'boolean' || !preferencePath) throw Error('Mail badge settings unavailable');
  const path = preferencePath;
  const save = writes.then(async () => { await writeFile(`${path}.tmp`, JSON.stringify({ enabled }), { mode: 0o600 }); await rename(`${path}.tmp`, path); preference = enabled; controller?.setEnabled(enabled); return enabled; });
  writes = save.then(() => {}, () => {});
  return save;
}
