import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { desktopNotificationShow } from "@/app/lib/desktop";
import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { ASSISTANT_NOTIFICATION_PREFERENCES_KEY, useAssistantNotificationPreferences } from "../domains/session/sidebar/assistant-notification-preferences";
import { AssistantMessageNotifications, assistantNotificationId, assistantNotificationTarget } from "../domains/session/sidebar/assistant-message-notifications";
import { assistantNotificationIcon } from "../domains/session/sidebar/assistant-notification-icon";
import { resolveLegalworkConnection } from "./legalwork-connection";
import { useDetachedWindow } from "./use-detached-window";
import { workspaceSessionRoute } from "./workspace-routes";

const CLICK_EVENT = "legalwork:desktop-notification-click";

/** Lives above routes so messages also arrive while Settings or another project is open. */
export function AssistantNotificationsListener() {
  const detached = useDetachedWindow();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const syncPreferences = (event: StorageEvent) => {
      if (event.key === ASSISTANT_NOTIFICATION_PREFERENCES_KEY) void useAssistantNotificationPreferences.persist.rehydrate();
    };
    window.addEventListener("storage", syncPreferences);
    return () => {
      window.removeEventListener("storage", syncPreferences);
    };
  }, []);

  useEffect(() => {
    if (detached || !isDesktopRuntime()) return;
    const click = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.id !== "string") return;
      const target = assistantNotificationTarget(event.detail.id);
      if (target) navigate(workspaceSessionRoute(target.workspaceId, target.sessionId));
    };
    window.addEventListener(CLICK_EVENT, click);
    return () => window.removeEventListener(CLICK_EVENT, click);
  }, [detached, navigate]);

  useEffect(() => {
    if (detached || !isDesktopRuntime()) return;
    const tracker = new AssistantMessageNotifications();
    const checked = new Map<string, number>();
    let stopped = false, running = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      if (running) { pending = true; return; }
      running = true;
      try {
        const connection = await resolveLegalworkConnection();
        if (!connection.normalizedBaseUrl || (!connection.resolvedToken && !connection.resolvedHostToken)) return;
        const client = createLegalworkServerClient({ baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken || undefined, hostToken: connection.resolvedHostToken || undefined });
        const assistant = await client.mainAssistantProfile();
        if (stopped || !assistant.workspace) return;
        const { sessions } = await client.sessionInbox();
        for (const entry of sessions) {
          if (stopped) return;
          if (entry.workspaceId !== assistant.workspace.id || entry.assistantAt <= tracker.startedAt) continue;
          const key = `${client.baseUrl}:${entry.workspaceId}:${entry.sessionId}`;
          if ((checked.get(key) ?? 0) >= entry.assistantAt) continue;
          const { item } = await client.getSessionSnapshot(entry.workspaceId, entry.sessionId, { limit: 40 });
          if (stopped) return;
          // Electron also checks every app window immediately before showing it.
          const foreground = document.visibilityState === "visible" && document.hasFocus();
          const reply = tracker.receive(item.messages, useAssistantNotificationPreferences.getState().desktopNotifications, foreground);
          checked.set(key, entry.assistantAt);
          if (reply) await desktopNotificationShow({
            id: assistantNotificationId(entry.workspaceId, entry.sessionId, reply.messageId),
            title: assistant.profile.name ?? t("assistant.title"), body: reply.body,
            iconDataUrl: await assistantNotificationIcon(assistant.profile.icon),
            conversationId: `assistant:${entry.workspaceId}`,
            backgroundOnly: true,
          });
        }
      } catch { /* Server starting or reconnecting. Keep the cursor and retry. */ }
      finally {
        running = false;
        if (!stopped) { timer = setTimeout(() => void poll(), pending ? 0 : 5000); pending = false; }
      }
    };
    const unsubscribe = onSyncPoke(poke => { if (poke.sessions || poke.resync) void poll(); });
    void poll();
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
  }, [detached]);
  return null;
}
