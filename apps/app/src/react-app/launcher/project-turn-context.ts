import { buildLegalworkWorkspaceBaseUrl, type LegalworkServerClient, type LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import { createClient } from "@/app/lib/opencode";
import { systemReminderPart } from "@/app/lib/system-reminder";
import { isOfficeAddinRuntime } from "@/app/lib/runtime-env";
import { buildFusionTraceSystemPrompt } from "@/react-app/domains/session/fusion/fusion-controller";
import { buildFusionDelegationSystemPrompt } from "@/react-app/domains/session/fusion/fusion-prompt";
import { getFusionSelectedModels, isFusionEnabled, useFusionStore } from "@/react-app/domains/session/fusion/fusion-store";
import { buildLegalworkEnvSystemContext } from "@/react-app/domains/session/sync/env-context";
import { visibleDashboardContext } from "@/react-app/domains/views/view-generation-sync";
import type { LauncherWorkspaceContext } from "@legalwork/types/launcher";
import { hashDraftProfile } from "./draft-profile";

export async function projectTurnContext(
  client: LegalworkServerClient,
  workspace: Pick<LegalworkWorkspaceInfo, "id" | "path">,
  sessionId: string,
  context: LauncherWorkspaceContext | null,
  separateWindow: boolean,
  command: boolean,
) {
  const items = [await buildLegalworkEnvSystemContext(client, { cacheKey: sessionId })];
  if (separateWindow) {
    const dashboard = context?.workspaceId === workspace.id ? context.dashboard : undefined;
    if (dashboard?.sessionId === sessionId && dashboard.profile === await hashDraftProfile(client.draftProfile)) items.push(dashboard.context);
  } else {
    items.push(visibleDashboardContext({ serverUrl: client.baseUrl, workspaceId: workspace.id, sessionId }));
  }
  if (!command && !isOfficeAddinRuntime()) {
    // The warmed Mini Bar has its own store. Read the current settings from Home.
    if (separateWindow) await useFusionStore.persist?.rehydrate();
    const models = getFusionSelectedModels(sessionId);
    const mount = buildLegalworkWorkspaceBaseUrl(client.baseUrl, workspace.id);
    if (isFusionEnabled(sessionId) && models.length && mount) {
      const engine = createClient(`${mount}/opencode`, workspace.path, { mode: "legalwork", token: client.token });
      items.push(await buildFusionTraceSystemPrompt({ client: engine, directory: workspace.path, sessionId }) ?? "");
      items.push(buildFusionDelegationSystemPrompt({ candidateModels: models }));
    }
  }
  const reminder = items.filter(Boolean).join("\n\n");
  return reminder ? [systemReminderPart(reminder)] : undefined;
}
