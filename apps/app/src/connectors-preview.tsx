import { HubScopeContext, HubScopeToggle, type HubScope } from "@/react-app/domains/settings/pages/hub-scope-context";
/** @jsxImportSource react */
// Development fixture for the real settings panel. No production build entry.
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";
import type { DynamicToolUIPart } from "ai";
import { EmailDraftSchema } from "@legalwork/types/email-draft";
import { CalendarEventDraftSchema } from "@legalwork/types/calendar-event-draft";
import { EmailDraftToolCard } from "@/components/chat/email-draft-card";
import { CalendarEventDraftToolCard } from "@/components/chat/calendar-event-draft-card";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { createRoot } from "react-dom/client";
import { FileStorageView } from "@/react-app/domains/settings/pages/file-storage-view";
import { StorageDriveTree } from "@/react-app/domains/session/panel/storage-drive-tree";
import { useQuery } from "@tanstack/react-query";
import { ConnectorConfig } from "@/react-app/domains/settings/connector-config";
import { ExtensionDetailModal } from "@/react-app/design-system/extension-detail-modal";
import { connectorDefinitions, connectorStatusSchema } from "@legalwork/types/connectors";
import { storageInputSchema, type StorageRoot, type StorageConnection } from "@legalwork/types/file-storage";
import { PlatformProvider, createDefaultPlatform } from "@/react-app/kernel/platform";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { createLegalworkServerClient, LegalworkServerError } from "@/app/lib/legalwork-server";
import { initLocale, t } from "@/i18n";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("The connector fixture is available only in development.");
initLocale();
const base = "http://127.0.0.1:44641";
const client = createLegalworkServerClient({ baseUrl: base, token: "fixture-client", hostToken: "fixture-host" });
const queryClient = new QueryClient();
const fixtureDraftsSchema = z.object({ workspaceId: z.string(), gmail: EmailDraftSchema, outlook: EmailDraftSchema, "google-calendar": CalendarEventDraftSchema, "outlook-calendar": CalendarEventDraftSchema, "google-calendar-update": CalendarEventDraftSchema });
const noop = () => {};

function StorageSignInPreview() {
  const [settings, setSettings] = useState(false);
  const connection: StorageConnection = {
    ...storageInputSchema.parse({ name: "Google Drive", config: { kind: "oauth", provider: "google-drive", sharingMode: "member" }, readOnly: true }),
    id: "team:signin-preview", updatedAt: 1, configuredSecrets: [], team: { orgId: "preview-firm", version: 1, installed: true },
  };
  const root: StorageRoot = { id: connection.id, name: connection.name, kind: "oauth", provider: "google-drive", writable: false };
  const previewClient = {
    ...client,
    storageChildren: async () => { throw new LegalworkServerError(409, "storage_signin_required", "Connect your own account in File Storage to use this team location."); },
    storageConnections: async () => ({ connections: [connection] }),
    storageOAuthProviders: async () => ({ providers: [] }),
    connectorSavedStatus: async () => connectorStatusSchema.parse({ configured: false, requiresSignIn: true, connectors: [] }),
  };
  return <PlatformProvider value={createDefaultPlatform()}><TooltipProvider>
    <main className="mx-auto min-h-dvh max-w-4xl space-y-6 px-8 py-10">
      <div><h1 className="text-xl font-semibold">{settings ? "File integrations" : "Memory Drive"}</h1><p className="mt-1 text-sm text-muted-foreground">Synthetic team location · No account or provider requests</p></div>
      {settings ? <FileStorageView client={previewClient} workspaceId="signin-preview" /> :
        <aside className="w-72"><StorageDriveTree client={previewClient} workspaceId="signin-preview" roots={[root]} onOpenFile={noop} onConnectStorage={() => setSettings(true)} /></aside>}
    </main>
  </TooltipProvider></PlatformProvider>;
}

function StoragePreview() {
  const [scope, setScope] = useState<HubScope>("local");
  const roots = useQuery({ queryKey: ["storage-roots", "fixture-project"], queryFn: () => client.storageRoots("fixture-project"), refetchOnWindowFocus: false });
  return <PlatformProvider value={{ ...createDefaultPlatform(), openLink: (authUrl) => {
    // The storage fixture completes synthetic Google consent without opening a provider.
    void fetch("http://127.0.0.1:44642/fixture/authorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "google-drive", authUrl }) });
  } }}><TooltipProvider><main className="mx-auto min-h-dvh max-w-6xl space-y-6 p-8">
    <h1 className="text-xl font-semibold">File Storage · Synthetic accounts</h1>
    <div className="grid gap-8 md:grid-cols-[15rem_1fr]">
      <aside className="rounded-2xl border p-2"><h2 className="p-2 text-sm font-medium">Memory Drive</h2>{roots.data && <StorageDriveTree client={client} workspaceId="fixture-project" roots={roots.data.roots} onOpenFile={() => {}} />}</aside>
      <div className="space-y-4"><HubScopeToggle scope={scope} onChange={setScope} /><HubScopeContext.Provider value={scope}><FileStorageView client={client} workspaceId="fixture-project" /></HubScopeContext.Provider></div>
    </div>
  </main></TooltipProvider></PlatformProvider>;
}

function DraftPreview() {
  const [data, setData] = useState<z.infer<typeof fixtureDraftsSchema> | null>(null);
  const [provider, setProvider] = useState<"gmail" | "outlook" | "google-calendar" | "outlook-calendar" | "google-calendar-update">("gmail");
  useEffect(() => { void fetch("http://127.0.0.1:44642/fixture/drafts").then(response => response.json()).then(value => setData(fixtureDraftsSchema.parse(value))); }, []);
  if (!data) return <p>Loading simulated connector drafts…</p>;
  const calendar = provider === "google-calendar" || provider === "outlook-calendar" || provider === "google-calendar-update";
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "legalwork_extension_call", toolCallId: `fixture-${provider}`, state: "output-available", input: { extensionId: provider === "google-calendar-update" ? "google-calendar" : provider, action: provider === "google-calendar-update" ? "update_event" : calendar ? "create_event" : "create_draft" }, output: { ok: true, result: { draft: data[provider] } } };
  return <QueryClientProvider client={queryClient}><TooltipProvider><MessageListProvider legalworkClient={client} workspaceId={data.workspaceId} sessionId="fixture-session" showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop}>
    <main className="mx-auto min-h-dvh max-w-3xl space-y-6 px-6 py-10">
      <div><h1 className="text-xl font-semibold">Connected draft cards</h1><p className="mt-1 text-sm text-muted-foreground">Isolated fixture · Simulated providers · No real email or calendar writes</p></div>
      <div className="flex flex-wrap gap-2">{["gmail", "outlook", "google-calendar", "outlook-calendar", "google-calendar-update"].map(id => <Button key={id} variant={id === provider ? "secondary" : "outline"} onClick={() => { if (id === "gmail" || id === "outlook" || id === "google-calendar" || id === "outlook-calendar" || id === "google-calendar-update") setProvider(id); }}>{id === "gmail" ? "Gmail" : id === "outlook" ? "Outlook Email" : id === "google-calendar" ? "Google Calendar" : id === "google-calendar-update" ? "Google Calendar update" : "Outlook Calendar"}</Button>)}</div>
      {calendar ? <CalendarEventDraftToolCard key={provider} part={part} /> : <EmailDraftToolCard key={provider} part={part} />}
    </main>
  </MessageListProvider></TooltipProvider></QueryClientProvider>;
}

function Preview() {
  const [provider, setProvider] = useState(() => connectorDefinitions.find(({ id }) => id === new URLSearchParams(window.location.search).get("provider"))?.id ?? "gmail");
  const [open, setOpen] = useState(true);
  const [connected, setConnected] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const dialog = new URLSearchParams(window.location.search).has("dialog");
  const definition = connectorDefinitions.find(item => item.id === provider);
  const platform = { ...createDefaultPlatform(), openLink: (url: string) => setAuthUrl(url) };
  const panel = <ConnectorConfig key={provider} id={provider} legalworkServerClient={client} presentation={dialog ? "dialog" : "panel"} onExtensionConnectionChange={(id, value) => { if (id === provider) setConnected(value); }} />;
  return <PlatformProvider value={platform}><TooltipProvider>
    <main className="mx-auto min-h-dvh max-w-3xl space-y-6 px-6 py-10">
      <div><h1 className="text-xl font-semibold">Email connections</h1><p className="mt-1 text-sm text-muted-foreground">Local verification fixture · Simulated accounts · No mailbox data</p></div>
      <div className="flex flex-wrap gap-2">{connectorDefinitions.map(({ id, name }) => <Button key={id} variant={id === provider ? "secondary" : "outline"} onClick={() => { setProvider(id); setAuthUrl(null); setOpen(true); setConnected(false); }}>{name}</Button>)}</div>
      {dialog && definition ? <>
        <Button onClick={() => setOpen(true)}>Open connector settings</Button>
        <ExtensionDetailModal open={open} onClose={() => setOpen(false)} name={definition.name} description={t(definition.descriptionKey)} iconSlug={definition.icon} kind="extension" connected={connected} presentation="connector" configSlot={panel} />
      </> : panel}
      {authUrl && <div className="space-y-2 rounded-lg border border-dashed p-4 text-sm"><p>The consent browser would open here.</p><Button variant="outline" onClick={() => {
        void fetch("http://127.0.0.1:44642/fixture/authorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: provider === "outlook-calendar" ? "outlook" : provider, authUrl }) }).then(() => setAuthUrl(null));
      }}>Complete simulated sign-in</Button></div>}
    </main>
  </TooltipProvider></PlatformProvider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root element not found.");
const previewRoot = createRoot(root);
previewRoot.render(new URLSearchParams(window.location.search).has("storage-signin") ? <QueryClientProvider client={queryClient}><StorageSignInPreview /></QueryClientProvider> : new URLSearchParams(window.location.search).has("storage") ? <QueryClientProvider client={queryClient}><StoragePreview /></QueryClientProvider> : new URLSearchParams(window.location.search).has("drafts") ? <DraftPreview /> : <Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
