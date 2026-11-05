import { useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import type { LegalworkSessionSnapshot } from "@/app/lib/legalwork-server";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { t } from "@/i18n";
import { EnvironmentVariableProvider } from "../../settings/pages/environment-variable-provider";
import { deriveRenderedSessionMessages } from "../surface/session-render-state";
import { snapshotKey, transcriptKey } from "../sync/session-sync";

/** Keep already-loaded history readable without contacting a disconnected service. */
export function DisconnectedChat({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const { data: snapshot } = useQuery<LegalworkSessionSnapshot>({
    queryKey: snapshotKey(workspaceId, sessionId), queryFn: skipToken,
  });
  const { data: transcript } = useQuery<UIMessage[]>({
    queryKey: transcriptKey(workspaceId, sessionId), queryFn: skipToken,
  });
  const messages = useMemo(() => deriveRenderedSessionMessages({ snapshot, transcriptState: transcript }), [snapshot, transcript]);

  if (messages.length === 0) return <div className="px-6 py-16 text-center text-sm text-dls-secondary">{t("session.loading_detail")}</div>;

  return <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[800px] px-6 py-6">
      {snapshot?.session.title && <h2 className="mb-6 text-sm font-medium text-dls-secondary">{snapshot.session.title}</h2>}
      <EnvironmentVariableProvider client={null}>
        <MessageListProvider workspaceId={workspaceId} sessionId={sessionId} readOnly
          showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
          dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}}
          onForkAtMessage={() => {}} onEditUserMessage={() => {}}>
          <MessageList messages={messages} status="ready" showWelcome={false} />
        </MessageListProvider>
      </EnvironmentVariableProvider>
    </div>
  </div>;
}
