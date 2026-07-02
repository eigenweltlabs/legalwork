/** @jsxImportSource react */
import { Navigate, Route, Routes } from "react-router-dom";

import { AppMenuProvider } from "@/react-app/shell/app-menu";
import { LegalworkControlProvider } from "@/react-app/shell/control/control-provider";
import { LoadingOverlay } from "@/react-app/shell/loading-overlay";
import { SessionRoute } from "@/react-app/shell/session-route";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { WordActionsDock } from "./word-actions-dock";

/**
 * Session-only routing for the Word task pane. Settings and onboarding
 * routes are deliberately absent -- that workflow stays in the LegalWork
 * app; unknown paths land back on the session view.
 */
export function WordAddinRoot() {
  return (
    <ShellConfigProvider>
      <AppMenuProvider>
        <LegalworkControlProvider>
          <Routes>
            <Route path="/session" element={<SessionRoute />} />
            <Route path="/session/:sessionId" element={<SessionRoute />} />
            <Route path="/workspace/:workspaceId/session" element={<SessionRoute />} />
            <Route path="/workspace/:workspaceId/session/:sessionId" element={<SessionRoute />} />
            <Route path="*" element={<Navigate to="/session" replace />} />
          </Routes>
          <WordActionsDock />
          <LoadingOverlay />
        </LegalworkControlProvider>
      </AppMenuProvider>
    </ShellConfigProvider>
  );
}
