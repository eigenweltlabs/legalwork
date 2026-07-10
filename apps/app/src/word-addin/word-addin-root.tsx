/** @jsxImportSource react */
import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

import { initAnalytics } from "@/app/lib/analytics";
import { initErrorAnalytics } from "@/app/lib/app-error";
import { AppErrorBoundary } from "@/react-app/shell/app-error-boundary";
import { AppMenuProvider } from "@/react-app/shell/app-menu";
import { LegalworkControlProvider } from "@/react-app/shell/control/control-provider";
import { LoadingOverlay } from "@/react-app/shell/loading-overlay";
import { SessionRoute } from "@/react-app/shell/session-route";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { t } from "@/i18n";
import { paneIconButtonClass, WordSessionsScreen, WordWorkspacesScreen } from "./word-screens";
import { WordToolRelayHost } from "./word-tool-relay";
import { WorkspaceAutoOpen } from "./workspace-auto-open";

/**
 * The chat itself is the app's SessionRoute (full agent surface, streaming,
 * permissions, composer) with the shell sidebar disabled; the pane adds its
 * own way back to the session list.
 */
function WordChatScreen() {
  const { workspaceId = "" } = useParams();
  const navigate = useNavigate();
  return (
    <div className="relative h-dvh">
      <SessionRoute />
      {/* Sits inside the chat header (restyled to pane metrics in
          word-pane.css) at the same spot as the pane headers' back button. */}
      <button
        type="button"
        className={`${paneIconButtonClass} fixed left-2 top-2 z-50`}
        aria-label={t("word_addin.back")}
        onClick={() =>
          navigate(workspaceId ? `/w/${encodeURIComponent(workspaceId)}/sessions` : "/")
        }
      >
        <ChevronLeft size={16} />
      </button>
    </div>
  );
}

/**
 * Task pane navigation: workspace picker -> session list -> chat. Settings
 * and onboarding stay in the LegalWork app; unknown paths land back on the
 * workspace picker.
 */
export function WordAddinRoot() {
  useEffect(() => {
    // The pane runs in Office's webview (no AppRoot), so it wires its own
    // analytics flush loop + error hooks. No app_opened here.
    initAnalytics();
    initErrorAnalytics();
  }, []);
  return (
    <AppErrorBoundary>
    <ShellConfigProvider>
      <AppMenuProvider>
        <LegalworkControlProvider>
          <Routes>
            <Route path="/" element={<WordWorkspacesScreen />} />
            <Route path="/w/:workspaceId/sessions" element={<WordSessionsScreen />} />
            <Route path="/workspace/:workspaceId/session" element={<WordChatScreen />} />
            <Route path="/workspace/:workspaceId/session/:sessionId" element={<WordChatScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <WordToolRelayHost />
          <WorkspaceAutoOpen />
          <LoadingOverlay />
        </LegalworkControlProvider>
      </AppMenuProvider>
    </ShellConfigProvider>
    </AppErrorBoundary>
  );
}
