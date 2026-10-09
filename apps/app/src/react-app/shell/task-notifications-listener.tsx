/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { useDetachedWindow } from "./use-detached-window";

import { toast } from "@/components/ui/sonner";
import { desktopNotificationShow } from "@/app/lib/desktop";
import { createLegalworkServerClient, type LegalworkTaskNotification } from "@/app/lib/legalwork-server";
import { isDesktopRuntime } from "@/app/utils";
import { useNotificationStore, useUnreadTaskCount } from "@/react-app/kernel/notification-store";
import { usePlatform, type Platform } from "@/react-app/kernel/platform";
import { onSyncPoke, useSyncEventsLive } from "@/react-app/kernel/sync-events";

import { taskNotificationPreferences, useTaskNotificationPreference } from "../domains/tasks/task-notification-preferences";
import {
  selectTaskAnnouncements,
  taskAnnouncementActionLabel,
  taskAnnouncementTarget,
  taskAnnouncementText,
  taskCenterEntry,
  taskNotificationDedupeKey,
  taskSystemNotificationId,
  taskSystemNotificationTarget,
} from "../domains/tasks/task-notifications";
import { setAppBadge } from "./app-badge";
import { resolveLegalworkConnection } from "./legalwork-connection";
import { notifyEvent } from "./notifications";
import { useShowTasksPane } from "./show-tasks-pane";

/**
 * How often the server is asked while it sends no sync events; with them, it
 * is asked whenever the tasks changed (a round, a reminder come due).
 */
const POLL_MS = 30_000;
/** The first ask after start: what came due, or arrived, while the app was closed. */
const FIRST_POLL_MS = 4_000;
/** A toast stays a little longer than a plain confirmation: it may need an answer. */
const TOAST_MS = 8_000;
/** Sent by the desktop shell when one of our system notifications is clicked. */
const DESKTOP_NOTIFICATION_CLICK_EVENT = "legalwork:desktop-notification-click";

function windowInFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Headless: announces tasks while the app runs. Whenever the tasks changed
 * (the server's sync events; every half minute without them) it claims the
 * task notifications the local server noted (task-notifications.ts on the
 * server), keeps what the user's settings ask for, and announces it: a
 * toast while the window is in front, a system notification while it is not.
 * Each is also kept as a notification center entry, which is what the count
 * next to Tasks in the sidebar reads until the Tasks pane is opened (the bell
 * itself is hidden in LegalWork) and the app icon shows as well. A click
 * opens the task in the Tasks pane, or the task list for several. Mounted
 * once per app window; a detached session window leaves the claiming, and
 * the app icon, to the main one.
 */
export function TaskNotificationsListener() {
  const detached = useDetachedWindow();
  const platform = usePlatform();
  const showTasksPane = useShowTasksPane();
  const showTasksPaneRef = useRef(showTasksPane);
  const platformRef = useRef<Platform>(platform);
  useEffect(() => {
    showTasksPaneRef.current = showTasksPane;
    platformRef.current = platform;
  });

  const unreadTasks = useUnreadTaskCount();
  const appBadge = useTaskNotificationPreference("appBadge").value;
  useEffect(() => {
    if (detached || !isDesktopRuntime()) return;
    void setAppBadge(appBadge ? unreadTasks : 0).catch(() => undefined);
  }, [appBadge, detached, unreadTasks]);

  useEffect(() => {
    if (detached) return;
    const onClick = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== "string") return;
      const target = taskSystemNotificationTarget(id);
      if (target !== undefined) showTasksPaneRef.current(target);
    };
    window.addEventListener(DESKTOP_NOTIFICATION_CLICK_EVENT, onClick);
    return () => window.removeEventListener(DESKTOP_NOTIFICATION_CLICK_EVENT, onClick);
  }, [detached]);

  useEffect(() => {
    if (detached) return;
    let stopped = false;
    let timer: number | undefined;

    const announce = (notifications: LegalworkTaskNotification[]) => {
      const preferences = taskNotificationPreferences();
      const announcements = selectTaskAnnouncements(notifications, preferences);
      if (announcements.length === 0) return;
      const inFront = windowInFront();
      for (const announcement of announcements) {
        const key = taskNotificationDedupeKey(announcement.kind);
        const unread = useNotificationStore
          .getState()
          .notifications.find((notification) => notification.dedupeKey === key && notification.readAt === null);
        notifyEvent(taskCenterEntry(announcement, unread));

        const { title, body } = taskAnnouncementText(announcement);
        const target = taskAnnouncementTarget(announcement.tasks);
        if (inFront) {
          toast(title, {
            id: key,
            description: body,
            duration: TOAST_MS,
            action: {
              label: taskAnnouncementActionLabel(announcement.tasks.length),
              onClick: () => showTasksPaneRef.current(target),
            },
          });
        } else if (preferences.system) {
          if (isDesktopRuntime()) {
            void desktopNotificationShow({ id: taskSystemNotificationId(target, nonce()), title, body }).catch(() => false);
          } else {
            void platformRef.current.notify(title, body, () => showTasksPaneRef.current(target));
          }
        }
      }
    };

    const poll = async (heard = false) => {
      window.clearTimeout(timer);
      try {
        if (!heard && useSyncEventsLive.getState().live) return;
        const connection = await resolveLegalworkConnection();
        const token = connection.resolvedToken || undefined;
        const hostToken = connection.resolvedHostToken || undefined;
        if (connection.normalizedBaseUrl && (token || hostToken)) {
          const client = createLegalworkServerClient({ baseUrl: connection.normalizedBaseUrl, token, hostToken });
          const { notifications } = await client.claimTaskNotifications();
          // Claimed is handed out: shown now, even if this window is closing.
          announce(notifications);
        }
      } catch {
        // The server is still starting, or predates task notifications: ask again later.
      } finally {
        // A claim for an event may overlap the clock's: one timer stays.
        window.clearTimeout(timer);
        if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
      }
    };

    timer = window.setTimeout(() => void poll(), FIRST_POLL_MS);
    const unsubscribe = onSyncPoke((poke) => {
      if (poke.tasks || poke.resync) void poll(true);
    });
    return () => {
      stopped = true;
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [detached]);

  return null;
}
