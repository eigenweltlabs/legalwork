import {LayoutSection,LayoutSectionHeader,LayoutSectionTitle,LayoutSectionDescription,LayoutSectionItem,LayoutSectionItemHeader,LayoutSectionItemTitle,LayoutSectionItemDescription,LayoutSectionItemHeaderActions} from '../settings/settings-layout';
import {SettingsNotice} from '../settings/settings-section';
import {MailSettingsSelect} from '../settings/pages/mail-settings-controls';
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
    return <LayoutSection>
      <LayoutSectionHeader><LayoutSectionTitle>Notifications</LayoutSectionTitle><LayoutSectionDescription>Choose what appears when new mail arrives.</LayoutSectionDescription></LayoutSectionHeader>
      <LayoutSectionItem><LayoutSectionItemHeader><LayoutSectionItemTitle>Desktop notifications</LayoutSectionItemTitle><LayoutSectionItemDescription>Your operating system controls notification permission and Do Not Disturb.</LayoutSectionItemDescription><LayoutSectionItemHeaderActions><Switch aria-label="Desktop mail notifications" checked={data?.preferences.enabled ?? false} disabled={!data || busy} onCheckedChange={enabled => void save({ enabled })}/></LayoutSectionItemHeaderActions></LayoutSectionItemHeader></LayoutSectionItem>
      <LayoutSectionItem><LayoutSectionItemHeader><LayoutSectionItemTitle>Message preview</LayoutSectionItemTitle><LayoutSectionItemDescription>Message bodies are never included in notifications.</LayoutSectionItemDescription><LayoutSectionItemHeaderActions><MailSettingsSelect aria-label="Notification preview" disabled={!data || busy} value={data?.preferences.preview ?? 'none'} onChange={value => { const preview = z.enum(['none', 'sender', 'subject']).parse(value); void save({ preview }); }}><option value="none">No message details</option><option value="sender">Sender only</option><option value="subject">Sender and subject</option></MailSettingsSelect></LayoutSectionItemHeaderActions></LayoutSectionItemHeader></LayoutSectionItem>
      <LayoutSectionItem><LayoutSectionItemHeader><LayoutSectionItemTitle>Play a sound</LayoutSectionItemTitle><LayoutSectionItemDescription>For new messages while LegalWork is running.</LayoutSectionItemDescription><LayoutSectionItemHeaderActions><Switch aria-label="Notification sound" checked={data?.preferences.sound ?? false} disabled={!data || busy} onCheckedChange={sound => void save({ sound })}/></LayoutSectionItemHeaderActions></LayoutSectionItemHeader></LayoutSectionItem>
      <LayoutSectionItem><LayoutSectionItemHeader><LayoutSectionItemTitle>Background mail</LayoutSectionItemTitle><LayoutSectionItemDescription>Sync and queued mail continue while LegalWork is running and this computer is awake. Quitting or sleeping stops mail work.</LayoutSectionItemDescription><LayoutSectionItemHeaderActions><Button variant="outline" size="sm" disabled={!data || busy} onClick={() => void save({ paused: !data?.preferences.paused })}>{data?.preferences.paused ? 'Resume mail' : 'Pause mail'}</Button></LayoutSectionItemHeaderActions></LayoutSectionItemHeader></LayoutSectionItem>
      {data && !data.status.supported && <SettingsNotice>Desktop notifications are unavailable on this system.</SettingsNotice>}{error && <SettingsNotice tone="error"><span role="alert">{error}</span></SettingsNotice>}
    </LayoutSection>;

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
