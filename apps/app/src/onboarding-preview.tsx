/** @jsxImportSource react */
// Dev-only fixture, deliberately absent from production Vite inputs.
// Uses the real onboarding steps without creating projects or changing device settings.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster, toast } from "@/components/ui/sonner";
import { createLegalworkServerClient, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { setLocale, t } from "@/i18n";
import { WelcomePage, type ProjectCreatePhase } from "@/react-app/domains/onboarding/welcome-page";
import { OfficeStep } from "@/react-app/domains/onboarding/office-step";
import { AudioStep } from "@/react-app/domains/onboarding/audio-step";
import { PermissionsStep } from "@/react-app/domains/onboarding/permissions-step";
import { AiPlansOverlay } from "@/react-app/domains/onboarding/ai-plans-overlay";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("The onboarding preview is available only in development.");
const params = new URLSearchParams(window.location.search);
setLocale(params.get("lang") === "de" ? "de" : "en");
document.documentElement.lang = params.get("lang") === "de" ? "de" : "en";
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const delay = () => new Promise<void>((resolve) => window.setTimeout(resolve, 700));
const queryClient = new QueryClient();
let previewConfig: Record<string, unknown> = {};
const permissionsClient: LegalworkServerClient = {
  ...createLegalworkServerClient({ baseUrl: "http://127.0.0.1:0" }),
  getConfig: async () => ({ opencode: previewConfig, legalwork: {} }),
  patchConfig: async (_workspaceId, payload) => {
    previewConfig = { ...previewConfig, ...payload.opencode };
    return {};
  },
};

function OnboardingPreview() {
  const [analytics, setAnalytics] = useState(true);
  const [phase, setPhase] = useState<ProjectCreatePhase | null>(null);
  const [step, setStep] = useState(params.get("step") ?? "welcome");
  const previewAction = () => toast.info("Preview only", { description: "Account and device settings are unchanged." });
  return (
    <>
      <div className="fixed right-6 top-5 z-50 rounded-full border border-border bg-background/90 px-3 py-1 text-[10px] text-muted-foreground">Preview · Simulated setup</div>
      {step === "office" ? <OfficeStep onBack={() => setStep("welcome")} onDone={() => setStep("audio")} />
      : step === "audio" ? <AudioStep legalworkClient={null} workspaceId={null} onBack={() => setStep("office")} onDone={() => setStep("permissions")} />
      : step === "permissions" ? <PermissionsStep legalworkClient={permissionsClient} runtimeWorkspaceId="preview" onConfigUpdated={() => {}} onBack={() => setStep("audio")} onDone={() => setStep("ai")} />
      : step === "ai" ? <AiPlansOverlay
        mode="onboarding"
        variant="new"
        account={null}
        serverReady
        onBack={() => setStep("permissions")}
        onStartSignIn={async () => { throw new Error("Sign-in is disabled in this preview."); }}
        onWaitSignIn={async () => ({ connected: false, cancelled: true })}
        onSignedIn={previewAction}
        onBringOwnModel={previewAction}
        onOpenBilling={previewAction}
        onCheckModels={async () => false}
      />
      : <WelcomePage
        totalSteps={params.has("web") ? 3 : 5}
        analyticsEnabled={analytics}
        onAnalyticsChange={setAnalytics}
        busy={phase !== null}
        busyPhase={phase}
        error={params.has("error") ? t("projects.create_folder_failed") : null}
        onPickFolder={params.has("web") ? undefined : async () => "/Users/you/Documents/Contract review"}
        onCreateProject={async (input) => {
          setPhase("project");
          await delay();
          setPhase("engine");
          await delay();
          setPhase(null);
          toast.success(`Preview: ${input.name}`, { description: "No project was created." });
          setStep(params.has("web") ? "permissions" : "office");
        }}
      />}
      <Toaster />
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root element not found");
createRoot(root).render(<QueryClientProvider client={queryClient}><TooltipProvider><OnboardingPreview /></TooltipProvider></QueryClientProvider>);
