import type { CalendarItem } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { createClient, unwrap } from "@/app/lib/opencode";
import { toSessionTransportDirectory } from "@/app/lib/session-scope";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { t } from "@/i18n";
import type { RouteWorkspace } from "../../shell/route-workspaces";
import { useComposerStateStore } from "../session/surface/composer-state-store";
import { createCalendarComposerMention, encodeComposerMentionValue } from "../session/surface/composer/mention-encoding";

export async function startCalendarSession(input: {
  item: CalendarItem;
  client: LegalworkServerClient;
  workspaceId: string;
  workspace: RouteWorkspace;
  baseUrl: string;
  token: string;
}) {
  const endpoint = resolveWorkspaceEndpoint(input.workspace, input);
  if (!endpoint || endpoint.workspaceId !== input.workspaceId || endpoint.baseUrl !== input.client.baseUrl) {
    throw new Error(t("tasks.linked_project_unavailable"));
  }
  const root = input.workspace.path?.trim() || undefined;
  const directory = toSessionTransportDirectory(root ?? "") || undefined;
  const opencode = createClient(endpoint.opencodeBaseUrl, root, { token: endpoint.token, mode: "legalwork" });
  const session = unwrap(await opencode.session.create({ directory, title: input.item.title }));
  try {
    await input.client.calendarWrite(input.workspaceId, `/${input.item.id}`, {
      revision: input.item.revision, sessionIds: [...new Set([...input.item.sessionIds, session.id])],
    }, "PATCH");
  } catch (error) {
    // This chat is still empty. Remove it if linking fails so a retry cannot duplicate it.
    await opencode.session.delete({ sessionID: session.id, directory }).catch(() => undefined);
    throw error;
  }
  const reference = createCalendarComposerMention(input.item.id, input.item.title);
  const composer = useComposerStateStore.getState();
  composer.setMentions(session.id, { [reference]: "calendar" });
  composer.setDraft(session.id, `@${encodeComposerMentionValue(reference)} ${t("tasks.session_draft_message")}`);
  return session.id;
}
