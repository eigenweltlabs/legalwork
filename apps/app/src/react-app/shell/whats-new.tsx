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
import { FileText, GitPullRequest, FolderOpen, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isDesktopRuntime } from "@/app/utils";
import { useLocal } from "@/react-app/kernel/local-provider";
import { t } from "@/i18n";

type WhatsNewEntry = {
  icon: LucideIcon;
  titleKey: string;
  bodyKey: string;
};

type WhatsNewAnnouncement = {
  /** Stable, unique, never reused. Convention: <feature>-<yyyy-mm>. */
  id: string;
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
    introKey: "whats_new.office.intro",
    entries: [
      {
        icon: FileText,
        titleKey: "whats_new.office.apps_title",
        bodyKey: "whats_new.office.apps_body",
      },
      {
        icon: GitPullRequest,
        titleKey: "whats_new.office.redline_title",
        bodyKey: "whats_new.office.redline_body",
      },
      {
        icon: FolderOpen,
        titleKey: "whats_new.office.workspace_title",
        bodyKey: "whats_new.office.workspace_body",
      },
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
    if (document.documentElement.classList.contains("lw-word-pane")) return;

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("whats_new.title")}</DialogTitle>
          <DialogDescription>{t(announcement.introKey)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          {announcement.entries.map((entry) => {
            const Icon = entry.icon;
            return (
              <div key={entry.titleKey} className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-dls-text">{t(entry.titleKey)}</div>
                  <div className="text-[12px] leading-relaxed text-dls-secondary">{t(entry.bodyKey)}</div>
                </div>
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>
            {t("whats_new.dismiss")}
          </Button>
          {announcement.cta ? <Button onClick={openCta}>{t(announcement.cta.labelKey)}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
