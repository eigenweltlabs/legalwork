/** @jsxImportSource react */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Lock } from "lucide-react";
import type { OrgPolicyKey } from "@legalwork/types/org-policy";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { openDesktopUrl } from "@/app/lib/desktop";
import { toast } from "@/components/ui/sonner";
import { globalSettingsRoute } from "@/react-app/shell/workspace-routes";

import { setFirmAnalyticsRefused } from "@/app/lib/analytics";
import { setFirmLanguage, t } from "@/i18n";
import { applyFirmReleaseChannel } from "@/react-app/domains/settings/state/electron-updater-state";

import { answerOrgPolicyConfirm, useOrgPolicy, useOrgPolicyListener, useOrgPolicyStore } from "./org-policy";

const RESTORED_SEEN_KEY = "legalwork.orgPolicy.restoredSeen";

function useOrgName(): string {
  return useOrgPolicyStore((state) => state.view?.orgName) || t("org_policy.your_firm");
}

/**
 * Under a setting the firm manages: who set it, and whether the member can
 * change it. Nothing when the firm does not manage it.
 */
export function OrgPolicyNote({ policyKey }: { policyKey: OrgPolicyKey }) {
  const entry = useOrgPolicyStore((state) => state.view?.entries[policyKey]);
  const lapsed = useOrgPolicyStore((state) => state.view?.state === "lapsed");
  const org = useOrgName();
  if (!entry) return null;
  const text = entry.locked
    ? t("org_policy.managed", { org })
    : entry.released
      ? entry.mode === "enforced" ? t("org_policy.released", { org }) : null
      : entry.mode === "default"
        ? t("org_policy.default", { org })
        : lapsed ? t("org_policy.lapsed", { org }) : null;
  if (!text) return null;
  const Icon = entry.locked ? Lock : Building2;
  return (
    <p data-slot="item-description" className="flex items-center gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

/** Where the firm provides providers or engines: after sign-out they wait for the member to sign in again. */
export function OrgPolicySignInHint({ policyKey }: { policyKey: "ai.chat.providers" | "ai.systemOne.providers" | "ai.ocr.engines" }) {
  const waiting = useOrgPolicyStore((state) => state.view?.state === "lapsed" && (state.view.entries[policyKey]?.value.length ?? 0) > 0);
  const org = useOrgName();
  if (!waiting) return null;
  return (
    <p data-slot="item-description" className="flex items-center gap-1.5 text-[12px] leading-relaxed text-muted-foreground">
      <Building2 className="size-3.5 shrink-0" aria-hidden />
      {t("org_policy.providers_sign_in", { org })}
    </p>
  );
}

/** Atop Settings while the firm manages anything here. */
export function OrgPolicyBanner() {
  const view = useOrgPolicyStore((state) => state.view);
  const navigate = useNavigate();
  const org = useOrgName();
  if (!view || view.state === "none") return null;
  if (view.state === "lapsed") {
    return (
      <Alert>
        <Building2 aria-hidden />
        <AlertDescription>{t("org_policy.banner_lapsed", { org })}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => navigate(globalSettingsRoute("account"))}>
            {t("org_policy.sign_in")}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const manage = view.role === "admin" && view.platformURL ? `${view.platformURL.replace(/\/+$/, "")}/policies` : null;
  return (
    <Alert>
      <Building2 aria-hidden />
      <AlertDescription>{t("org_policy.banner_active", { org })}</AlertDescription>
      {manage ? (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={() => void openDesktopUrl(manage)}>
            {t("org_policy.manage")}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

/**
 * Mounted once per window: keeps the policy current, asks before the member
 * takes back a setting their firm enforces, and says once when signing in put
 * the firm's settings back.
 */
export function OrgPolicyRoot() {
  useOrgPolicyListener();
  const confirm = useOrgPolicyStore((state) => state.confirm);
  const restored = useOrgPolicyStore((state) => state.view?.restored);
  const org = useOrgName();
  const language = useOrgPolicy("language")?.value ?? null;
  const analyticsOff = useOrgPolicy("privacy.shareAnonymousUsage")?.value === false;
  const releaseChannel = useOrgPolicy("updates.channel")?.value;

  // Settings that live outside React follow the firm's policy here.
  useEffect(() => setFirmLanguage(language), [language]);
  useEffect(() => setFirmAnalyticsRefused(analyticsOff), [analyticsOff]);
  useEffect(() => {
    if (releaseChannel) void applyFirmReleaseChannel(releaseChannel).catch(() => undefined);
  }, [releaseChannel]);

  useEffect(() => {
    if (!restored) return;
    try {
      if (localStorage.getItem(RESTORED_SEEN_KEY) === String(restored.at)) return;
      localStorage.setItem(RESTORED_SEEN_KEY, String(restored.at));
    } catch {
      // Without storage the notice may repeat; it is still right.
    }
    toast(t("org_policy.restored", { org, count: restored.count }));
  }, [restored, org]);

  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) answerOrgPolicyConfirm(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("org_policy.confirm_title", { org })}</AlertDialogTitle>
          <AlertDialogDescription>{t("org_policy.confirm_body", { org })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <Button onClick={() => answerOrgPolicyConfirm(true)}>{t("org_policy.confirm_change")}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
