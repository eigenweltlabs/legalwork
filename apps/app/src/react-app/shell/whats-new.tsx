/** @jsxImportSource react */
/**
 * One-time "What's new" announcements shown after app updates.
 *
 * Best-practice rules encoded here:
 * - Opt-in per release: no entry in WHATS_NEW_ANNOUNCEMENTS, no modal.
 *   Each announcement has a stable id; once dismissed (CTA, Got it, Esc,
 *   or backdrop) that id never shows again. No nagging.
 * - Fresh installs never see announcements: to a new user everything is
 *   new, so while onboarding is incomplete all pending announcements are
 *   absorbed silently.
 * - At most one announcement per app start, shown after a short delay so
 *   it never competes with boot.
 * - `when` gates platform-specific features (e.g. desktop only).
 *
 * To announce a feature in a release: prepend an entry to
 * WHATS_NEW_ANNOUNCEMENTS with a new id and i18n keys. That is all.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { isDesktopRuntime, isOfficeAddinRuntime } from "@/app/utils";
import { useLocal } from "@/react-app/kernel/local-provider";
import { t } from "@/i18n";

type WhatsNewEntry = {
  titleKey: string;
  bodyKey: string;
};

type WhatsNewAnnouncement = {
  /** Stable, unique, never reused. Convention: <feature>-<yyyy-mm>. */
  id: string;
  /** Small uppercase eyebrow inside the hero, e.g. "What's new". */
  eyebrowKey: string;
  headlineKey: string;
  introKey: string;
  entries: WhatsNewEntry[];
  /** Optional primary action that takes the user into the feature. */
  cta?: { labelKey: string; route: string };
  /** Optional gate, e.g. desktop-only features. */
  when?: () => boolean;
};

/** Newest first. The first pending entry whose `when` passes is shown. */
const WHATS_NEW_ANNOUNCEMENTS: WhatsNewAnnouncement[] = [
  {
    id: "office-addins-2026-07",
    eyebrowKey: "whats_new.title",
    headlineKey: "whats_new.office.headline",
    introKey: "whats_new.office.intro",
    entries: [
      { titleKey: "whats_new.office.apps_title", bodyKey: "whats_new.office.apps_body" },
      { titleKey: "whats_new.office.redline_title", bodyKey: "whats_new.office.redline_body" },
      { titleKey: "whats_new.office.workspace_title", bodyKey: "whats_new.office.workspace_body" },
    ],
    cta: { labelKey: "whats_new.office.cta", route: "/settings/office-addins" },
    when: () => isDesktopRuntime(),
  },
];

const SEEN_STORAGE_KEY = "legalwork.whatsNewSeen";

function readSeenIds(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function markSeen(ids: string[]): void {
  try {
    const merged = [...new Set([...readSeenIds(), ...ids])];
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage unavailable: the announcement may show again next start.
  }
}

export function WhatsNewDialog(props: { hasWorkspaces: boolean; workspacesReady: boolean }) {
  const local = useLocal();
  const navigate = useNavigate();
  const [announcement, setAnnouncement] = useState<WhatsNewAnnouncement | null>(null);
  const [isPreview, setIsPreview] = useState(false);
  const { hasWorkspaces, workspacesReady } = props;
  // Fresh-install detection must not rely on hasCompletedOnboarding alone:
  // profiles that predate the flag report false forever. Anyone with an
  // existing workspace is an existing user.
  const isFreshInstall = !local.prefs.hasCompletedOnboarding && !hasWorkspaces;

  useEffect(() => {
    // Never in the Office task pane (it renders SessionRoute too): the
    // narrow sidebar is no place for release announcements, and the pane
    // shares localStorage with nothing that should absorb them either.
    if (isOfficeAddinRuntime()) return;

    // QA hook: localStorage.setItem("legalwork.whatsNewPreview", "1")
    // force-shows the newest announcement, ignoring seen state and
    // platform gates, and never marks it seen.
    let preview = false;
    try {
      preview = window.localStorage.getItem("legalwork.whatsNewPreview") === "1";
    } catch {
      // ignore
    }
    if (preview && WHATS_NEW_ANNOUNCEMENTS.length > 0) {
      setIsPreview(true);
      setAnnouncement(WHATS_NEW_ANNOUNCEMENTS[0] ?? null);
      return;
    }

    // Decide nothing before workspaces have settled: during boot every
    // profile briefly looks like a fresh install (0 workspaces) and would
    // absorb its announcements by accident.
    if (!workspacesReady) return;

    const seen = readSeenIds();
    const pending = WHATS_NEW_ANNOUNCEMENTS.filter(
      (entry) => !seen.includes(entry.id) && (entry.when?.() ?? true),
    );
    if (pending.length === 0) return;

    if (isFreshInstall) {
      // Fresh install: everything is new to this user, absorb silently.
      markSeen(WHATS_NEW_ANNOUNCEMENTS.map((entry) => entry.id));
      return;
    }

    const timer = window.setTimeout(() => setAnnouncement(pending[0] ?? null), 1200);
    return () => window.clearTimeout(timer);
  }, [isFreshInstall, workspacesReady]);

  if (!announcement) return null;

  const dismiss = () => {
    if (!isPreview) markSeen([announcement.id]);
    setAnnouncement(null);
  };

  const openCta = () => {
    const route = announcement.cta?.route;
    dismiss();
    if (route) navigate(route);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        {/* Hero: the welcome page's deep-navy paper gradient, dialog-sized. */}
        <div className="relative overflow-hidden bg-[#05080f] px-7 pb-8 pt-7">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(120%_120%_at_85%_-10%,rgba(35,82,222,0.55),transparent_55%),radial-gradient(90%_90%_at_0%_110%,rgba(24,73,139,0.45),transparent_55%)]"
          />
          <div className="relative">
            <span className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white/60">
              <span className="size-[7px] rounded-[1.5px] bg-[#2352DE] shadow-[0_0_0_3px_rgba(35,82,222,0.25)]" />
              {t(announcement.eyebrowKey)}
            </span>
            <DialogTitle className="mt-3 text-[26px] font-medium leading-[1.08] tracking-[-0.03em] text-white">
              {t(announcement.headlineKey)}
            </DialogTitle>
            <p className="mt-2.5 max-w-sm text-[13px] leading-[1.6] text-white/70">
              {t(announcement.introKey)}
            </p>
          </div>
        </div>

        {/* Numbered feature rows, exactly like the welcome page steps. */}
        <div className="flex flex-col px-7 py-2">
          {announcement.entries.map((entry, index) => (
            <div
              key={entry.titleKey}
              className={`flex items-start gap-4 py-4 ${index > 0 ? "border-t border-dls-border" : ""}`}
            >
              <span className="pt-0.5 font-mono text-[12px] tabular-nums text-dls-secondary/70">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div className="text-[14px] font-medium tracking-[-0.01em] text-dls-text">
                  {t(entry.titleKey)}
                </div>
                <div className="mt-1 text-[13px] leading-relaxed text-dls-secondary">{t(entry.bodyKey)}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2 px-7 pb-6 pt-1">
          {announcement.cta ? (
            <Button size="lg" className="w-full text-white" onClick={openCta}>
              {t(announcement.cta.labelKey)}
            </Button>
          ) : null}
          <button
            type="button"
            className="w-full py-1.5 text-center text-[12px] text-dls-secondary transition-colors hover:text-dls-text"
            onClick={dismiss}
          >
            {t("whats_new.dismiss")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
