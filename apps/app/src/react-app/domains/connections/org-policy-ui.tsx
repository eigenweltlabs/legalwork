/** @jsxImportSource react */
import { useEffect, useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

/** What the admin enforced, for the settings with a note that are not feature switches; a switch says which way. */
const ENFORCED_TEXT = {
  language: "org_policy.set_language",
  "personalization.personality": "org_policy.set_personality",
  branding: "org_policy.set_branding",
  "reviews.defaults": "org_policy.set_reviews",
  "updates.channel": "org_policy.set_release_channel",
  "updates.autoCheck": { on: "org_policy.auto_check_on", off: "org_policy.auto_check_off" },
  "updates.autoDownload": { on: "org_policy.auto_download_on", off: "org_policy.auto_download_off" },
  "privacy.shareAnonymousUsage": "org_policy.usage_off",
  notifications: "org_policy.set_notifications",
  "ai.systemOne.model": "org_policy.set_systemone_model",
  "ai.ocr.defaultEngine": "org_policy.set_ocr_engine",
} satisfies Partial<Record<OrgPolicyKey, Text>>;

type NoteKey = AllowKey | keyof typeof ENFORCED_TEXT;


function isAllowKey(key: NoteKey): key is AllowKey {
  return !Object.hasOwn(ENFORCED_TEXT, key);
}

/** What the admin did to a setting; nothing for a feature they left on. */
function adminText(key: NoteKey, value: unknown): string | null {
  if (isAllowKey(key)) return value === false ? orgPolicyOffText(key) : null;
  const text: Text = ENFORCED_TEXT[key];
  return t(typeof text === "string" ? text : value === false ? text.off : text.on);
}

/**
 * Under a setting the firm enforces: what the admin set, or after sign-out that
 * the member may change it. Nothing for a default or a setting the firm leaves alone.
 */
export function OrgPolicyNote(
  props:
    | { policyKey: NoteKey }
    // Where a page shows only some of the tools: what the admin set there, as a translation key.
    | { policyKey: "tools.permissions"; locked: string },
) {
  const entry = useOrgPolicyStore((state) => state.view?.entries[props.policyKey]);
  const lapsed = useOrgPolicyStore((state) => state.view?.state === "lapsed");
  const org = useOrgName();
  if (!entry) return null;
  // A default is just the starting value: nothing to say about it.
  if (entry.mode !== "enforced") return null;
  const text = entry.locked
    ? props.policyKey === "tools.permissions" ? t(props.locked) : adminText(props.policyKey, entry.value)
    : entry.released
      ? t("org_policy.released", { org })
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

/** On a provider, engine or hub item the firm added for every member, or one the member added from what the firm offers. */
export function FirmItemNote({ added = false }: { added?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <Building2 className="size-3.5 shrink-0" aria-hidden />
      {t(added ? "org_policy.firm_item_added" : "org_policy.firm_item")}
    </span>
  );
}

/** The member's own API key for one of the firm's providers or engines that asks for it. */
export function MemberKeyDialog({ name, onSave, onClose }: { name: string; onSave: (key: string) => Promise<void>; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(key.trim());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("org_policy.own_key_failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("org_policy.own_key_title", { name })}</DialogTitle>
            <DialogDescription>{t("org_policy.own_key_desc")}</DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            aria-label={t("org_policy.own_key_label")}
            placeholder={t("org_policy.own_key_label")}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!key.trim() || busy}>{t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
