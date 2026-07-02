/** @jsxImportSource react */
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AppMenuProvider } from "@/react-app/shell/app-menu";
import { LegalworkControlProvider } from "@/react-app/shell/control/control-provider";
import { LoadingOverlay } from "@/react-app/shell/loading-overlay";
import { SessionRoute } from "@/react-app/shell/session-route";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { t } from "@/i18n";
import { WordActionsDock } from "./word-actions-dock";
import { WordSessionsScreen, WordWorkspacesScreen } from "./word-screens";

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
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="fixed left-1.5 top-1.5 z-50 size-7 rounded-full border border-dls-border bg-dls-surface/90 backdrop-blur"
        aria-label={t("word_addin.back")}
        onClick={() =>
          navigate(workspaceId ? `/w/${encodeURIComponent(workspaceId)}/sessions` : "/")
        }
      >
        <ChevronLeft size={15} />
      </Button>
      <WordActionsDock />
    </div>
  );
}

/**
 * Task pane navigation: workspace picker -> session list -> chat. Settings
 * and onboarding stay in the LegalWork app; unknown paths land back on the
 * workspace picker.
 */
export function WordAddinRoot() {
  return (
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
          <LoadingOverlay />
        </LegalworkControlProvider>
      </AppMenuProvider>
    </ShellConfigProvider>
  );
}
