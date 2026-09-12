import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
const preferenceSchema = z.object({ enabled: z.boolean(), preview: z.enum(['none', 'sender', 'subject']), sound: z.boolean(), paused: z.boolean() }).strict();
const defaults = { enabled: false, preview: 'none', sound: false, paused: false };
/** Owns only Mail banners and power hooks; badges and other notifications stay separate. */
export function createMailDesktopController({ service, Notification, powerMonitor, onOpen, preferences = defaults, intervalMs = 5000 }) {
    let settings = preferenceSchema.parse(preferences), stopped = false, busy = false, sleeping = false, screenLocked = false, sessionId = randomUUID(), revision = 0, lifecycleError = false, appliedLifecycle;
    const active = new Set();
    const clear = () => { for (const notice of active)
        notice.close(); active.clear(); };
    const reset = () => { revision++; sessionId = randomUUID(); clear(); };
    const lifecycle = async () => { const desired = sleeping || settings.paused; if (appliedLifecycle === desired && !lifecycleError)
        return; try {
        await service.setLifecycleSuspended(desired);
        appliedLifecycle = desired;
        lifecycleError = false;
    }
    catch {
        lifecycleError = true;
    } };
    async function refresh() {
        if (stopped || busy)
            return;
        busy = true;
        const generation = revision;
        try {
            await lifecycle();
            if (stopped || generation !== revision || sleeping || screenLocked || service.status().state !== 'ready')
                return;
            const batch = await service.pollNotifications({ sessionId, enabled: settings.enabled && Notification.isSupported(), preview: settings.preview });
            if (stopped || generation !== revision || sleeping || screenLocked || !settings.enabled || service.status().state !== 'ready' || !batch.items.length)
                return;
            const item = batch.items[0], total = batch.items.length + batch.suppressed;
            // Recheck current account/message scope immediately before exposing an OS preview.
            const current = await service.readMessage(item.target.accountId, item.target.locator);
            if (current.removed || current.isRead === true || stopped || generation !== revision || sleeping || screenLocked)
                return;
            const notice = new Notification({ title: total > 1 ? `${total} new mail messages` : item.title, body: total > 1 ? 'Open the newest message in LegalWork.' : item.body, silent: !settings.sound });
            notice.on('click', () => { if (stopped || generation !== revision)
                return; void service.readMessage(item.target.accountId, item.target.locator).then(message => { if (!message.removed && !stopped && generation === revision)
                onOpen(item.target); }).catch(() => { }); });
            notice.on('close', () => active.delete(notice));
            notice.on('failed', () => active.delete(notice));
            for (const old of active)
                old.close();
            active.clear();
            active.add(notice);
            notice.show();
        }
        catch { /* No previews escape a failed account read or unavailable mail worker. */ }
        finally {
            busy = false;
        }
    }
    const suspend = () => { sleeping = true; reset(); void lifecycle(); }, resume = () => { sleeping = false; reset(); void refresh(); }, lock = () => { screenLocked = true; reset(); }, unlock = () => { screenLocked = false; reset(); void refresh(); };
    const listeners = { suspend, resume, 'lock-screen': lock, 'unlock-screen': unlock };
    for (const [event, callback] of Object.entries(listeners))
        powerMonitor.on(event, callback);
    const timer = setInterval(() => void refresh(), intervalMs);
    timer.unref?.();
    void lifecycle();
    void refresh();
    return { refresh, settings() { return { ...settings }; }, status() { return { supported: Notification.isSupported(), state: lifecycleError ? 'unavailable' : sleeping ? 'suspended' : settings.paused ? 'paused' : service.status().state === 'ready' ? 'running' : 'unavailable' }; }, async configure(value) { settings = preferenceSchema.parse(value); reset(); await lifecycle(); void refresh(); return { ...settings }; }, stop() { stopped = true; reset(); clearInterval(timer); for (const [event, callback] of Object.entries(listeners))
            powerMonitor.off(event, callback); } };
}
let controller, path;
let preferences = { ...defaults }, writes = Promise.resolve();
export async function configureMailDesktop({ app, service, Notification, powerMonitor }) {
    path = join(app.getPath('userData'), 'mail-notifications.json');
    try {
        preferences = preferenceSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    }
    catch {
        preferences = { ...defaults };
    }
    controller?.stop();
    await service.setLifecycleSuspended(preferences.paused);
    controller = createMailDesktopController({ service, Notification, powerMonitor, preferences, onOpen: target => app.emit('legalwork-mail-open', target) });
    const active = controller, stop = service.stop.bind(service);
    service.stop = async () => { active.stop(); if (controller === active)
        controller = undefined; await stop(); };
}
export function getMailDesktopSettings() { return { preferences: { ...preferences }, status: controller?.status() ?? { supported: false, state: 'unavailable' } }; }
export function setMailDesktopSettings(value) { const next = preferenceSchema.parse(value); if (!path)
    return Promise.reject(Error('Mail settings unavailable')); const target = path; const operation = writes.then(async () => { await writeFile(target + '.tmp', JSON.stringify(next), { mode: 0o600 }); await rename(target + '.tmp', target); preferences = next; await controller?.configure(next); return getMailDesktopSettings(); }); writes = operation.catch(() => { }); return operation; }
