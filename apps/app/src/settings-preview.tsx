/** @jsxImportSource react */
// Dev-only fixture, deliberately absent from production Vite inputs.
// The real settings shell, overview, and privacy controls use local sample state.
import { useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { Settings2 } from "lucide-react";

import type { SettingsTab } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Toaster, toast } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initLocale } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { SystemOneSettingsSection } from "@/react-app/domains/settings/pages/systemone-view";
import { AiSettingsView, type AiSettingsViewProps } from "@/react-app/domains/settings/pages/ai-view";
import type { SystemOneSettings, SystemOneProviderInput, SystemOneSelection } from "@legalwork/types/systemone";
import { GeneralSettingsView } from "@/react-app/domains/settings/pages/general-view";
import { PreferencesView } from "@/react-app/domains/settings/pages/preferences-view";
import { SettingsShell } from "@/react-app/domains/settings/shell/settings-shell";
import { AppearanceView } from "@/react-app/domains/settings/pages/appearance-view";
import type { HideAppMode } from "@/react-app/kernel/local-provider";
import { ReloadCoordinatorProvider } from "@/react-app/shell/reload-coordinator";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("The settings fixture is available only in development.");
initLocale();

const params = new URLSearchParams(window.location.search);
const workspaces = [
  { id: "visual-workspace", name: "Northstar Legal", color: "#6c6c76" },
  { id: "visual-personal", name: "Personal", color: "#6c6c76" },
];

// In-memory SystemOne fixture. Connection tests here never send model requests.
const systemOneSample: SystemOneSettings = {
  selection: { providerId: "eigenwelt", model: "EigenJev" },
  providers: [{ id: "eigenwelt", name: "Eigenwelt", endpoint: "https://api.eigenweltlabs.com/v1/systemone", models: [{ id: "EigenJev", name: "EigenJev Europe", source: "configured", questionTypes: ["noul", "choice", "score"] }], managed: true, enabled: true, status: "ready", region: "EU" }],
};
const systemOnePreview = {
  systemOneSettings: async () => structuredClone(systemOneSample),
  systemOneSaveProvider: async ({ apiKey: _key, ...provider }: SystemOneProviderInput): Promise<{ ok: true }> => {
    systemOneSample.providers = [...systemOneSample.providers.filter(p => p.id !== provider.id), { ...provider, models: [{ id: "jev-latest", name: "jev-latest", questionTypes: ["noul", "choice", "score"], source: "discovered" }, { id: "jev-preview", name: "jev-preview", questionTypes: ["noul", "choice", "score"], source: "discovered" }, ...provider.models.map((model) => ({ ...model, source: "configured" }))], managed: false, status: provider.enabled ? "ready" : "disabled" }];
    return { ok: true };
  },
  systemOneDeleteProvider: async (id: string): Promise<{ ok: true }> => { systemOneSample.providers = systemOneSample.providers.filter(p => p.id !== id); return { ok: true }; },
  systemOneSelect: async (selection: SystemOneSelection): Promise<{ ok: true }> => { systemOneSample.selection = selection; return { ok: true }; },
  systemOneTest: async (): Promise<{ ok: true }> => ({ ok: true }),
};

function SettingsPreview() {
  // Repaint on language change, the way AppRoot does in the real app.
  useLocale();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const requested = params.get("tab");
    return requested === "preferences" || requested === "appearance" || requested === "ai" ? requested : "general";
  });
  const [compact, setCompact] = useState(params.has("compact"));
  const [selectedWorkspace, setSelectedWorkspace] = useState(workspaces[0]);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);
  const [hideAppMode, setHideAppMode] = useState<HideAppMode>("recording");
  const [providers, setProviders] = useState<AiSettingsViewProps["connectedProviders"]>(
    params.has("empty-providers") ? [] : [
      { id: "anthropic", name: "Anthropic", source: "api" },
      { id: "openai", name: "OpenAI", source: "env" },
      { id: "custom-preview", name: "Firm models", source: "custom", editableAsCustom: true },
      { id: "google", name: "Google", source: "api" },
    ],
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-muted/30">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-4 py-1.5 text-[11px] text-muted-foreground">
        <span>Settings visual preview · Local sample state · No connected services</span>
        <div className="flex items-center gap-1">
          <Button size="xs" variant={compact ? "ghost" : "secondary"} aria-pressed={!compact} onClick={() => setCompact(false)}>Full page</Button>
          <Button size="xs" variant={compact ? "secondary" : "ghost"} aria-pressed={compact} onClick={() => setCompact(true)}>Compact panel</Button>
        </div>
      </div>
      <div className={cn("min-h-0 flex-1 [&>div]:h-full [&>div]:min-h-0", compact && "mx-auto my-6 w-[min(480px,calc(100%-32px))] overflow-hidden rounded-2xl border border-border")}>
        <SettingsShell
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          developerMode={false}
          selectedWorkspaceId={selectedWorkspace.id}
          selectedWorkspaceName={selectedWorkspace.name}
          selectedWorkspaceColor={selectedWorkspace.color}
          workspaces={workspaces}
          compact={compact}
          onSelectWorkspace={(id) => {
            const workspace = workspaces.find((item) => item.id === id);
            if (workspace) setSelectedWorkspace(workspace);
          }}
          onClose={() => toast("Settings preview", { description: "Use the session preview to return to a sample conversation." })}
        >
          {activeTab === "general" ? (
            <GeneralSettingsView onNavigateTab={setActiveTab} developerMode={false} />
          ) : activeTab === "ai" ? (
            <AiSettingsView
              busy={false}
              providerAuthBusy={false}
              providerStatusLabel={providers.length ? "Connected" : "Disconnected"}
              providerStatusStyle=""
              providerSummary={providers.length ? `${providers.length} providers connected` : "No providers connected yet."}
              connectedProviders={providers}
              disconnectingProviderId={null}
              providerConnectError={null}
              providerDisconnectStatus={null}
              providerDisconnectError={null}
              onOpenProviderAuth={() => toast("Preview provider connection")}
              onDisconnectProvider={(id) => setProviders(current => current.filter(provider => provider.id !== id))}
              onReplaceProviderKey={() => toast("Preview key replacement")}
              onEditProvider={() => toast("Preview provider editing")}
              canDisconnectProvider={(source) => source !== "env" && source !== "config"}
              eigenweltConnected={!params.has("disconnected-account")}
              onManageEigenweltAccount={() => toast("Preview Eigenwelt account")}
              cloudProviderIds={new Set(["google"])}
              systemOneView={<SystemOneSettingsSection client={systemOnePreview} onManageSubscription={() => toast("Preview subscription")} />}
            />
          ) : activeTab === "appearance" ? (
            // The same language picker Settings -> Customization renders.
            <AppearanceView busy={false} />
          ) : activeTab === "preferences" ? (
            <PreferencesView
              busy={false}
              showThinking
              onToggleShowThinking={() => {}}
              autoCompactContext
              autoCompactContextBusy={false}
              onToggleAutoCompactContext={() => {}}
              analyticsEnabled={analyticsEnabled}
              onToggleAnalytics={() => setAnalyticsEnabled((value) => !value)}
              hideAppMode={hideAppMode}
              onChangeHideAppMode={setHideAppMode}
            />
          ) : (
            <PanelEmptyState icon={<Settings2 />} title="Connected settings" description="This section requires the running app. The overview and Privacy pages are available in this visual preview.">
              <Button variant="outline" size="sm" onClick={() => setActiveTab("general")}>Back to overview</Button>
            </PanelEmptyState>
          )}
        </SettingsShell>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root element not found");
createRoot(root).render(
  <MotionConfig reducedMotion="user">
    <TooltipProvider>
      <ShellConfigProvider>
        <ReloadCoordinatorProvider>
          <BrowserRouter><SettingsPreview /></BrowserRouter>
          <Toaster />
        </ReloadCoordinatorProvider>
      </ShellConfigProvider>
    </TooltipProvider>
  </MotionConfig>,
);
