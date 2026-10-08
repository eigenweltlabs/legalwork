/** @jsxImportSource react */
// Development-only synthetic fixture, excluded from production Vite inputs.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { MailProvider, MailPluginStatus } from "@legalwork/types/mail-plugins";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { MailPluginConfig } from "@/react-app/domains/settings/mail-plugin-config";
import { PlatformProvider } from "@/react-app/kernel/platform";
import { initLocale, setLocale } from "@/i18n";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("This mail fixture is available only in development.");
initLocale();
if (new URLSearchParams(location.search).get("lang") === "de") setLocale("de");
const states: Record<MailProvider, MailPluginStatus> = { gmail: { provider: "gmail", configured: true, connected: false, accounts: [] }, outlook: { provider: "outlook", configured: true, connected: false, accounts: [] } };
let pending: { provider: MailProvider; canWrite: boolean; complete: boolean; cancelled: boolean } | null = null;
let fail = false;
let onCancel = () => {};
const client: Pick<LegalworkServerClient, "mailPluginStatus" | "mailPluginConnectStart" | "mailPluginConnectStatus" | "mailPluginConnectCancel" | "mailPluginDisconnect" | "mailPluginWorkspaceAccess"> = {
  mailPluginStatus: async (provider) => structuredClone(states[provider]),
  mailPluginConnectStart: async (provider, options) => { if (new URLSearchParams(location.search).has("slow")) await new Promise((resolve) => setTimeout(resolve, 2000)); pending = { provider, canWrite: options.canWrite, complete: false, cancelled: false }; return { flowId: "synthetic-signin", authUrl: "https://example.com/synthetic-signin", expiresAt: Date.now() + 300_000 }; },
  mailPluginConnectStatus: async (provider) => {
    if (pending?.cancelled) return { status: "cancelled", error: null };
    if (fail) return { status: "failed", error: "Your administrator needs to approve this application." };
    if (!pending?.complete) return { status: "pending", error: null };
    states[provider] = { provider, configured: true, connected: true, accounts: [{ id: `${provider}-fixture`, provider, email: "partner@northstar.example", name: "Northstar partner", canWrite: pending.canWrite, connectedAt: new Date().toISOString(), workspaceAccess: true }] };
    return { status: "connected", error: null };
  },
  mailPluginConnectCancel: async () => { if (pending) pending.cancelled = true; onCancel(); return { ok: true }; },
  mailPluginDisconnect: async (provider) => { states[provider].accounts = []; states[provider].connected = false; return { ...structuredClone(states[provider]), providerRevoked: provider === "gmail", revocationUrl: "https://example.com" }; },
  mailPluginWorkspaceAccess: async (provider, accountId, _workspaceId, enabled) => { const account = states[provider].accounts.find((item) => item.id === accountId); if (account) account.workspaceAccess = enabled; return structuredClone(states[provider]); },
};
function Preview() {
  const [provider, setProvider] = useState<MailProvider>("gmail");
  const [opened, setOpened] = useState(0);
  const [cancelled, setCancelled] = useState(0);
  onCancel = () => setCancelled((value) => value + 1);
  return <PlatformProvider value={{ platform: "web", openLink: () => setOpened((value) => value + 1), restart: async () => {}, notify: async () => {} }}><main className="mx-auto max-w-3xl space-y-6 p-6 md:p-10">
    <header><p className="text-xs uppercase tracking-widest text-muted-foreground">Developer preview · synthetic accounts</p><h1 className="mt-2 text-2xl font-semibold">Email plugins</h1><p className="mt-1 text-sm text-muted-foreground">Project: Northstar Legal</p></header>
    <nav className="flex gap-2"><Button variant={provider === "gmail" ? "default" : "outline"} onClick={() => setProvider("gmail")}>Gmail</Button><Button variant={provider === "outlook" ? "default" : "outline"} onClick={() => setProvider("outlook")}>Outlook</Button></nav>
    <MailPluginConfig key={provider} provider={provider} hostLegalworkServerClient={client} localWorkspaceId="preview-project" />
    <aside className="flex flex-wrap gap-2 border-t border-border pt-4"><Button size="sm" variant="outline" onClick={() => { if (pending) pending.complete = true; }}>Complete synthetic sign-in</Button><Button size="sm" variant="outline" onClick={() => { fail = !fail; }}>Toggle administrator rejection</Button></aside>
    <p className="text-xs text-muted-foreground">Browser sign-ins opened: {opened}</p>
    <p className="text-xs text-muted-foreground">Sign-ins cancelled: {cancelled}</p>
  </main></PlatformProvider>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Preview root is missing.");
createRoot(root).render(<Preview />);
