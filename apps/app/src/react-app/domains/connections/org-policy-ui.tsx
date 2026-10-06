/** @jsxImportSource react */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Lock } from "lucide-react";
import type { OrgPolicyKey, OrgPolicyMode } from "@legalwork/types/org-policy";

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
import { toast } from "@/components/ui/sonner";
import { globalSettingsRoute } from "@/react-app/shell/workspace-routes";

import { setFirmAnalyticsRefused } from "@/app/lib/analytics";
import { setFirmLanguage, t } from "@/i18n";
import { applyFirmReleaseChannel } from "@/react-app/domains/settings/state/electron-updater-state";

import {
  answerOrgPolicyConfirm,
  orgPolicyOffText,
  useOrgPolicy,
  useOrgPolicyListener,
  useOrgPolicyStore,
  type AllowKey,
} from "./org-policy";

const RESTORED_SEEN_KEY = "legalwork.orgPolicy.restoredSeen";

function useOrgName(): string {
  return useOrgPolicyStore((state) => state.view?.orgName) || t("org_policy.your_firm");
}

type Text = string | { on: string; off: string };

/**
 * What the admin did, for the settings with a note that are not on/off
 * switches of a feature: when they enforced it, and when they set a default.
 * A switch says which way.
 */
const SET_TEXT = {
  language: { enforced: "org_policy.set_language", default: "org_policy.default_language" },
  "personalization.personality": { enforced: "org_policy.set_personality", default: "org_policy.default_personality" },
  branding: { enforced: "org_policy.set_branding", default: "org_policy.default_branding" },
  "ai.systemOne.model": { enforced: "org_policy.set_systemone_model", default: "org_policy.default_systemone_model" },
  "ai.ocr.defaultEngine": { enforced: "org_policy.set_ocr_engine", default: "org_policy.default_ocr_engine" },
  "updates.channel": { enforced: "org_policy.set_release_channel", default: "org_policy.default_release_channel" },
  "reviews.defaults": { enforced: "org_policy.set_reviews", default: "org_policy.default_reviews" },
  "updates.autoCheck": {
    enforced: { on: "org_policy.auto_check_on", off: "org_policy.auto_check_off" },
    default: { on: "org_policy.default_auto_check_on", off: "org_policy.default_auto_check_off" },
  },
  "updates.autoDownload": {
    enforced: { on: "org_policy.auto_download_on", off: "org_policy.auto_download_off" },
    default: { on: "org_policy.default_auto_download_on", off: "org_policy.default_auto_download_off" },
  },
  "privacy.shareAnonymousUsage": {
    enforced: { on: "org_policy.usage_on", off: "org_policy.usage_off" },
    default: { on: "org_policy.default_usage_on", off: "org_policy.default_usage_off" },
  },
} satisfies Partial<Record<OrgPolicyKey, Record<OrgPolicyMode, Text>>>;

type NoteKey = AllowKey | keyof typeof SET_TEXT;

function isAllowKey(key: NoteKey): key is AllowKey {
  return !Object.hasOwn(SET_TEXT, key);
}

/** What the admin did to a setting; nothing for a feature they left on. */
function adminText(key: NoteKey, mode: OrgPolicyMode, value: unknown): string | null {
  if (isAllowKey(key)) return mode === "enforced" && value === false ? orgPolicyOffText(key) : null;
  const text: Text = SET_TEXT[key][mode];
  return t(typeof text === "string" ? text : value === false ? text.off : text.on);
}

/**
 * Under a setting the firm manages: what the admin set, and whether the member
 * can change it. Nothing when the firm does not manage it.
 */
export function OrgPolicyNote(
  props:
    | { policyKey: NoteKey }
    // Where a page shows only some of the tools: what the admin set there, as translation keys.
    | { policyKey: "tools.permissions"; text: Record<OrgPolicyMode, string> },
) {
  const entry = useOrgPolicyStore((state) => state.view?.entries[props.policyKey]);
  const lapsed = useOrgPolicyStore((state) => state.view?.state === "lapsed");
  const org = useOrgName();
  if (!entry) return null;
  const admin = (mode: OrgPolicyMode) =>
    props.policyKey === "tools.permissions" ? t(props.text[mode]) : adminText(props.policyKey, mode, entry.value);
  const text = entry.locked
    ? admin("enforced")
    : entry.released
      ? entry.mode === "enforced" ? t("org_policy.released", { org }) : null
      : entry.mode === "default"
        ? admin("default")
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

/** In place of a feature the firm switched off for its members. */
export function OrgPolicyFeatureOff({ policyKey }: { policyKey: "recorder.allow" | "evaluations.allow" }) {
  return (
    <Alert>
      <Lock />
      <AlertDescription>{orgPolicyOffText(policyKey)}</AlertDescription>
    </Alert>
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

/** On a connector, skill or plugin the firm installed for every member. */
export function FirmItemNote() {
  const org = useOrgName();
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <Building2 className="size-3.5 shrink-0" aria-hidden />
      {t("org_policy.firm_item", { org })}
    </span>
  );
}

/** The firm's instructions, read-only, below the member's own. */
export function FirmInstructions() {
  const instructions = useOrgPolicy("personalization.firmInstructions")?.value;
  const org = useOrgName();
  if (!instructions) return null;
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[13px] font-medium">
        <Building2 className="size-3.5 shrink-0" aria-hidden />
        {t("org_policy.firm_instructions", { org })}
      </p>
      <p className="whitespace-pre-wrap rounded-2xl border border-border bg-muted px-4 py-3.5 text-sm text-muted-foreground">{instructions}</p>
    </div>
  );
}

/** Atop Settings while the member is signed out of the firm. */
export function OrgPolicyBanner() {
  const lapsed = useOrgPolicyStore((state) => state.view?.state === "lapsed");
  const navigate = useNavigate();
  const org = useOrgName();
  if (!lapsed) return null;
  // The action sits below the text: the button is wider than the room the alert keeps for one.
  return (
    <Alert className="w-full lg:max-w-3xl has-data-[slot=alert-action]:pe-4">
      <Building2 aria-hidden />
      <AlertDescription>{t("org_policy.banner_lapsed", { org })}</AlertDescription>
      <AlertAction className="static col-start-2 mt-2">
        <Button size="sm" variant="outline" onClick={() => navigate(globalSettingsRoute("account"))}>
          {t("org_policy.sign_in")}
        </Button>
      </AlertAction>
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

  return <OrgPolicyConfirmDialog />;
}

/** Asks before the member takes back a setting their firm enforces (after sign-out). */
export function OrgPolicyConfirmDialog() {
  const confirm = useOrgPolicyStore((state) => state.confirm);
  const org = useOrgName();
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
