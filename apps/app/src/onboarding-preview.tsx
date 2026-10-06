/** @jsxImportSource react */
// Dev-only fixture, deliberately absent from production Vite inputs.
// Uses the real onboarding steps without creating projects or changing device settings.
import { StrictMode, useRef, useState } from "react";
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
import { SyncProviderSetup } from "@/react-app/domains/connections/provider-auth/sync-provider-setup";
import ProviderAuthModal from "@/react-app/domains/connections/provider-auth/provider-auth-modal";
import { usageLimitFixture } from "@/react-app/design-system/usage-limit-fixture";
import type { EigenweltPlanId } from "@/app/lib/eigenwelt-plans";
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
      {step === "ai" && params.has("sync-flow") ? <SyncFlowPreview />
      : step === "office" ? <OfficeStep onBack={() => setStep("welcome")} onDone={() => setStep("audio")} />
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

// Explicit, local-only checkout/sign-in simulation. No account or payment API is called.
function SyncFlowPreview() {
  const [plan, setPlan] = useState<EigenweltPlanId | null>(params.get("sync-flow") === "signed-in" ? "sync" : null);
  const [waiting, setWaiting] = useState(false);
  const [providerAuth, setProviderAuth] = useState<{ preferredProviderId?: string; startOAuth?: boolean } | null>(null);
  const [oauthStarts, setOauthStarts] = useState(0);
  const fixture = useRef(usageLimitFixture("sync", params.get("role") !== "member", "openai"));
  const [previewClient] = useState<LegalworkServerClient>(() => ({
    ...createLegalworkServerClient({ baseUrl: "https://legalwork-preview.invalid" }),
    eigenweltEntitlements: async () => fixture.current.entitlements,
    eigenweltUsage: async () => fixture.current.usage,
    eigenweltUsageAction: async (_workspaceId, action) => {
      if (action.action === "request") return { ok: true };
      if (action.action !== "memberChange" || !fixture.current.usage.isAdmin) throw new Error("Preview action unavailable");
      if (action.preview) return { quoteId: "preview-quote", amountCents: 1500, recurringAmountCents: action.target.kind === "plan" && action.target.plan === "pro" ? 8900 : 3900, billingInterval: "month" };
      if (action.target.kind !== "plan" || (action.target.plan !== "plus" && action.target.plan !== "pro")) throw new Error("Preview plan unavailable");
      fixture.current = usageLimitFixture(action.target.plan, true, "openai");
      fixture.current.usage.me.remainingCents = fixture.current.usage.me.allowanceCents;
      setPlan(action.target.plan);
      return { ok: true };
    },
  }));
  const finish = useRef<(() => void) | null>(null);
  return <>
    {plan ? <div className="p-12"><h1 className="text-2xl">Sync plan active · Preview</h1></div> : <AiPlansOverlay
      mode="onboarding"
      variant={params.get("variant") === "ended" ? "ended" : params.get("sync-flow") === "sign-in" ? "signed-out" : "new"}
      account={null}
      serverReady
      onStartSignIn={async options => { sessionStorage.setItem("preview-checkout", JSON.stringify(options)); setWaiting(true); return { authorizeUrl: "about:blank", sessionId: "preview" }; }}
      onWaitSignIn={async (_sessionId, options) => new Promise<{ connected: boolean }>(resolve => {
        finish.current = () => resolve({ connected: !options.cancelled() });
      })}
      onSignedIn={selected => setPlan(selected ?? "sync")}
      onBringOwnModel={() => toast.info("Preview provider connection")}
      onOpenBilling={() => {}}
      onCheckModels={async () => false}
    />}
    {waiting && <button className="fixed bottom-6 right-6 z-[60] rounded-full border bg-background px-4 py-2 text-sm" onClick={() => {
      setWaiting(false);
      finish.current?.();
    }}>Complete simulated checkout / sign-in</button>}
    <SyncProviderSetup
      client={previewClient}
      workspaceId="preview"
      paused={providerAuth !== null}
      connection={plan ? {
        connected: true, platformURL: null,
        account: { userId: "preview", orgId: "preview", userName: "Preview", userEmail: null, orgName: "Preview" },
        entitlements: { plan, subscriptionStatus: "active", features: [], seats: 1, usage: {
          window: "week", allowanceCents: 0, remainingCents: 0, usedPercent: 0, resetsAt: null,
          dailyAllowanceCents: 0, dailyRemainingCents: 0, dailyUsedPercent: 0,
          extraUsageEnabled: true, prepaidBalanceCents: 0,
        } },
      } : null}
      connectedProviders={params.get("own-provider") === "connected" ? [{ id: "openai" }] : []}
      onChooseProvider={(preferredProviderId, startOAuth) => setProviderAuth({ preferredProviderId, startOAuth })}
    />
    <p className="fixed bottom-4 left-4 text-xs text-muted-foreground">Preview OAuth starts: {oauthStarts}</p>
    {providerAuth && <ProviderAuthModal open loading={false} submitting={false} error={null}
      preferredProviderId={providerAuth.preferredProviderId} startOAuth={providerAuth.startOAuth}
      workerType={params.get("worker") === "remote" ? "remote" : "local"}
      providers={[{ id: "openai", name: "OpenAI", env: [] }, { id: "anthropic", name: "Anthropic", env: [] }]}
      connectedProviderIds={[]}
      authMethods={{
        openai: [
          { type: "api", label: "API key", methodIndex: 1 },
          { type: "oauth", label: "ChatGPT Plus/Pro (browser)", methodIndex: 3 },
          { type: "oauth", label: "ChatGPT Plus/Pro (headless)", methodIndex: 7 },
        ],
        anthropic: [{ type: "api", label: "API key", methodIndex: 0 }],
      }}
      onSelect={async (_providerId, methodIndex) => {
        setOauthStarts(value => value + 1);
        toast.info(`Preview OAuth method: ${methodIndex}`);
        return { methodIndex: methodIndex ?? 3, authorization: { url: "about:blank", method: "auto", instructions: "Simulated sign-in. No account is connected." } };
      }}
      onSubmitOAuth={async () => ({ connected: false, pending: true })}
      onSubmitApiKey={async () => { toast.info("Preview connection only"); setProviderAuth(null); }}
      onClose={() => setProviderAuth(null)}
    />}
  </>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root element not found");
createRoot(root).render(<StrictMode><QueryClientProvider client={queryClient}><TooltipProvider><OnboardingPreview /></TooltipProvider></QueryClientProvider></StrictMode>);
