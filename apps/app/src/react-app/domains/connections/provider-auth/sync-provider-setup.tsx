import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { EigenweltEntitlementsView, LegalworkServerClient } from "@/app/lib/legalwork-server";
import { needsSyncProviderSetup } from "@/app/lib/eigenwelt-access";
import { t } from "@/i18n";
import { ChatGptLogo } from "./chatgpt-plan-card";
import { useSyncProviderSetupState } from "./sync-provider-setup-state";
import { AiPlanUpgradeDialog } from "../usage-control/ai-plan-upgrade-dialog";

export function SyncProviderSetup({ client, workspaceId, connection, connectedProviders, paused = false, onChooseProvider }: {
  client?: LegalworkServerClient | null;
  workspaceId?: string | null;
  connection: EigenweltEntitlementsView | null | undefined;
  connectedProviders: readonly { id: string }[] | null;
  paused?: boolean;
  onChooseProvider: (preferredProviderId?: string, startOAuth?: boolean) => void;
}) {
  const { dismissedAccounts, dismiss } = useSyncProviderSetupState();
  const [upgradeAccountKey, setUpgradeAccountKey] = useState<string | null>(null);
  const accountKey = connection?.connected && connection.account
    ? `${connection.account.orgId}:${connection.account.userId}` : null;
  const open = accountKey !== null && !dismissedAccounts.has(accountKey) && !paused &&
    needsSyncProviderSetup({ eigenwelt: connection, connectedProviders });
  const choose = (providerId?: string, startOAuth = false) => {
    if (accountKey) dismiss(accountKey);
    onChooseProvider(providerId, startOAuth);
  };
  return (
    <>
    <Dialog open={open} onOpenChange={value => { if (!value && accountKey) dismiss(accountKey); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ai_plans.provider_title")}</DialogTitle>
          <DialogDescription>{t("ai_plans.provider_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2.5">
              <ChatGptLogo className="size-7" />
              <p className="text-[15px] font-medium">{t("providers.chatgpt_plan_title")}</p>
            </div>
            <p className="text-sm text-muted-foreground">{t("ai_plans.provider_openai_hint")}</p>
            <Button className="w-full" onClick={() => choose("openai", true)}>{t("ai_plans.provider_openai")}</Button>
          </div>
          <Button variant="outline" className="w-full" onClick={() => choose()}>{t("ai_plans.provider_other")}</Button>
          <Button variant="ghost" className="w-full" disabled={!client || !workspaceId} onClick={() => {
            if (!accountKey) return;
            dismiss(accountKey);
            setUpgradeAccountKey(accountKey);
          }}>{t("ai_plans.upgrade_include_ai")}</Button>
        </div>
      </DialogContent>
    </Dialog>
    {upgradeAccountKey === accountKey && upgradeAccountKey && client && workspaceId && <AiPlanUpgradeDialog
      client={client}
      workspaceId={workspaceId}
      platformURL={connection?.platformURL}
      onClose={() => setUpgradeAccountKey(null)}
    />}
    </>
  );
}
