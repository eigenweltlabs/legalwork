/** @jsxImportSource react */
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
export const mailDesktopSettingsSchema = z.object({ preferences: z.object({ enabled: z.boolean(), preview: z.enum(['none', 'sender', 'subject']), sound: z.boolean(), paused: z.boolean() }).strict(), status: z.object({ supported: z.boolean(), state: z.enum(['running', 'suspended', 'paused', 'unavailable']) }).strict() }).strict();
export function MailDesktopPreferences() {
    const [data, setData] = useState<z.infer<typeof mailDesktopSettingsSchema>>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const bridge = window.__LEGALWORK_ELECTRON__;
    useEffect(() => { let active = true; const read = async () => { try {
        const value = await bridge?.mailDesktopSettings?.();
        if (active && value)
            setData(mailDesktopSettingsSchema.parse(value));
    }
    catch {
        if (active)
            setError('Mail notification settings are unavailable. Retry when the local connection is ready.');
    } }; void read(); const timer = setInterval(() => void read(), 5000); return () => { active = false; clearInterval(timer); }; }, [bridge]);
    if (!bridge?.mailDesktopSettings)
        return null;
    async function save(patch: Partial<z.infer<typeof mailDesktopSettingsSchema>['preferences']>) { if (!data)
        return; setBusy(true); setError(''); try {
        setData(mailDesktopSettingsSchema.parse(await bridge?.mailDesktopSettingsSave?.({ ...data.preferences, ...patch })));
    }
    catch {
        setError('Mail settings could not be saved. Retry.');
    }
    finally {
        setBusy(false);
    } }
    return <section className="space-y-3" aria-label="Mail notifications and background"><h3>Notifications and background mail</h3><div className="flex items-center justify-between gap-4"><span>Desktop mail notifications</span><Switch aria-label="Desktop mail notifications" checked={data?.preferences.enabled ?? false} disabled={!data || busy} onCheckedChange={enabled => void save({ enabled })}/></div><label className="flex items-center justify-between gap-4">Notification preview<select aria-label="Notification preview" disabled={!data || busy} value={data?.preferences.preview ?? 'none'} onChange={event => { const preview = z.enum(['none', 'sender', 'subject']).parse(event.target.value); void save({ preview }); }}><option value="none">No message details</option><option value="sender">Sender only</option><option value="subject">Sender and subject</option></select></label><div className="flex items-center justify-between gap-4"><span>Notification sound</span><Switch aria-label="Notification sound" checked={data?.preferences.sound ?? false} disabled={!data || busy} onCheckedChange={sound => void save({ sound })}/></div><p className="text-xs text-muted-foreground">Message bodies are never included. Your operating system controls permission and Do Not Disturb. Historical downloads and app relaunches do not replay alerts.</p>{data && !data.status.supported && <p role="status">Desktop notifications are unavailable on this system.</p>}<div className="flex items-center justify-between gap-4"><span role="status">{data?.status.state === 'running' ? 'Mail runs in the background' : data?.status.state === 'paused' ? 'Background mail paused' : data?.status.state === 'suspended' ? 'Mail suspended while the computer sleeps' : 'Mail connection unavailable'}</span><Button variant="outline" size="sm" disabled={!data || busy} onClick={() => void save({ paused: !data?.preferences.paused })}>{data?.preferences.paused ? 'Resume mail' : 'Pause mail'}</Button></div><p className="text-xs text-muted-foreground">Sync and queued mail work require LegalWork to be running and this computer awake. Sleep suspends work; waking resumes connected accounts while preserving account pauses. Quitting stops all mail work. Nothing sends while the computer is off.</p>{error && <p role="alert">{error}</p>}</section>;
}
export function MailBackgroundStatus() { const [status, setStatus] = useState<string>(); useEffect(() => { let active = true; const read = async () => { try {
    const value = await window.__LEGALWORK_ELECTRON__?.mailDesktopSettings?.();
    if (active && value)
        setStatus(mailDesktopSettingsSchema.parse(value).status.state);
}
catch {
    if (active)
        setStatus('unavailable');
} }; void read(); const timer = setInterval(() => void read(), 3000); return () => { active = false; clearInterval(timer); }; }, []); return status ? <span className="mail-background-status" role="status" title="Mail work stops during sleep and after quitting. Nothing sends while this computer is off.">{status === 'running' ? 'Background mail active' : status === 'paused' ? 'Background mail paused' : status === 'suspended' ? 'Mail suspended' : 'Mail unavailable'}</span> : null; }
