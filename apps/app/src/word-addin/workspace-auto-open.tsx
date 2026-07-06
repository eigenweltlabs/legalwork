/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import { fetchDocumentPath, officeHostName } from "./office";
import { useWordServerClient } from "./use-word-server-client";
import { matchWorkspaceForDocument } from "./workspace-match";

/**
 * On pane open inside Office, if the open document lives inside one of the
 * user's LegalWork workspaces, jump straight to that workspace's sessions.
 * Otherwise stay on the workspace overview. Runs once per pane load and only
 * while the user is still on the overview, so it never yanks them away after
 * they have navigated.
 */

// Module-level so a StrictMode double-mount doesn't attempt twice.
let autoOpenAttempted = false;

export function WorkspaceAutoOpen() {
  const client = useWordServerClient();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  locationRef.current = location.pathname;

  useEffect(() => {
    if (autoOpenAttempted) return;
    autoOpenAttempted = true;
    if (!officeHostName()) return; // only inside an Office host

    let cancelled = false;
    void (async () => {
      const docPath = await fetchDocumentPath().catch(() => null);
      // Unsaved doc (no path) or a cloud (http) URL: nothing local to match.
      if (!docPath || cancelled) return;

      let workspaces: LegalworkWorkspaceInfo[];
      try {
        workspaces = (await client.listWorkspaces()).items ?? [];
      } catch {
        return;
      }
      if (cancelled) return;

      const match = matchWorkspaceForDocument(docPath, workspaces);
      // Only auto-navigate if the user has not moved off the overview meanwhile.
      if (match && locationRef.current === "/") {
        client.activateWorkspace(match.id).catch(() => undefined);
        navigate(`/w/${encodeURIComponent(match.id)}/sessions`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, navigate]);

  return null;
}
