/**
 * The count on LegalWork's app icon: the Dock on macOS, the launcher on
 * Linux, the taskbar on Windows. It shows what the sidebar shows next to
 * Tasks — the task notifications not yet seen (notification-store
 * `countUnreadTasks`) — and clears when the Tasks pane is opened.
 */
import { desktopBadgeSet } from "@/app/lib/desktop";
import { t } from "@/i18n";

/** What the badge reads: the count, capped the way the sidebar caps it. */
export function appBadgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/**
 * Windows has no count on the taskbar icon, only a small image laid over it:
 * a round badge with the number, drawn here at twice its 16 px size.
 */
function drawOverlay(count: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(16, 16, 16, 0, Math.PI * 2);
  context.fill();
  const label = appBadgeLabel(count);
  context.fillStyle = "#ffffff";
  context.font = `600 ${label.length > 1 ? 17 : 21}px system-ui, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 16, 17);
  return canvas.toDataURL("image/png");
}

/** Show `count` on the app icon; 0 clears it. Desktop only; best-effort. */
export async function setAppBadge(count: number): Promise<void> {
  const windows = window.__LEGALWORK_ELECTRON__?.meta?.platform === "windows";
  await desktopBadgeSet({
    count,
    overlayDataUrl: windows && count > 0 ? drawOverlay(count) : null,
    description: count > 0 ? t("tasks.app_badge", { count }) : "",
  });
}
