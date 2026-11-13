import type { UIMessage } from "ai";
import type { AssistantOnboardingState } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { useLocale } from "@/i18n/use-locale";
import { AssistantOnboardingConversation } from "./assistant-onboarding-conversation";

export function AssistantDateDivider({ date }: { date: string }) {
  const locale = useLocale();
  const label = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(`${date}T12:00:00`));
  return <div className="flex items-center gap-3 py-6 text-[11px] text-muted-foreground" data-assistant-date={date}><span className="h-px flex-1 bg-border" /><time dateTime={date}>{label}</time><span className="h-px flex-1 bg-border" /></div>;
}

/** Old daily contexts share the bounded history window and remain read-only. */
export function AssistantHistory({ client, workspaceId, sections, onboarding }: {
  client: LegalworkServerClient; workspaceId: string;
  sections: { sessionId: string; date?: string; messages: UIMessage[] }[];
  onboarding?: AssistantOnboardingState;
}) {
  return <>{sections.map(day => <section key={day.sessionId} aria-label={day.date}>
    {day.date && <AssistantDateDivider date={day.date} />}
    {onboarding?.step === "complete" && onboarding.sessionId === day.sessionId && <AssistantOnboardingConversation workspaceId={workspaceId} state={onboarding} />}
    <MessageListProvider assistantChat legalworkClient={client} workspaceId={workspaceId} sessionId={day.sessionId} readOnly showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
      dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}>
      <MessageList messages={day.messages} status="ready" showWelcome={false} />
    </MessageListProvider>
  </section>)}</>;
}
