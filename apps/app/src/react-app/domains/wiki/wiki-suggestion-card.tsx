import { useMetadataPolling } from "@/react-app/infra/metadata-polling";
import { suggestionOutcome, suggestionTab, suggestionTools } from "./wiki-suggestion-model";
import { useEffect, useRef } from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { FilePenLine } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMessageList } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";

export function WikiSuggestionCard({ part }: { part: DynamicToolUIPart }) {
  const { legalworkClient } = useMessageList();
  const metadataInterval = useMetadataPolling(legalworkClient?.baseUrl, 5000);
  const open = useRequestPanelTab();
  const original = suggestionOutcome(part.output);
  const { data } = useQuery({ queryKey: ["wiki-suggestion", legalworkClient?.baseUrl, original?.workspaceId, original?.id], enabled: Boolean(legalworkClient && original),
    queryFn: () => legalworkClient!.wikiSuggestion(original!.workspaceId, original!.id), refetchInterval: metadataInterval });
  const item = data ?? original;
  if (!item) return null;
  return <div className="my-3 flex items-center gap-3 rounded-xl border p-3"><FilePenLine className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.title}</p><p className="text-xs text-muted-foreground">{item.status === "pending" ? "Wiki suggestion · Ready for your review" : item.status === "saved" ? "Saved to wiki" : "Dismissed"}</p></div><Button size="sm" variant="outline" onClick={() => open(suggestionTab(item), { besideChat: true })}>{item.status === "pending" ? "Review" : "Open"}</Button></div>;
}

/** Open new results beside the chat. Replaying a transcript never opens old drafts. */
export function useWikiSuggestions(messages: UIMessage[], running: boolean) {
  const { sessionId } = useMessageList();
  const session = useRef(sessionId);
  const open = useRequestPanelTab();
  const seen = useRef<Set<string> | null>(null);
  const live = useRef(new Set<string>());
  useEffect(() => {
    if (session.current !== sessionId) { session.current = sessionId; seen.current = null; live.current.clear(); }
    if (running) for (const message of messages) for (const part of message.parts) if (part.type === "dynamic-tool" && suggestionTools.includes(part.toolName)) live.current.add(part.toolCallId);
    const completed = messages.flatMap(message => message.parts.flatMap(part => part.type === "dynamic-tool" && suggestionTools.includes(part.toolName) && part.state === "output-available" ? [part] : []));
    if (!seen.current) { seen.current = new Set(completed.map(part => part.toolCallId)); return; }
    for (const part of completed) {
      if (seen.current.has(part.toolCallId)) continue;
      seen.current.add(part.toolCallId);
      const item = suggestionOutcome(part.output);
      if (item && (running || live.current.has(part.toolCallId))) open(suggestionTab(item), { besideChat: true });
    }
  }, [messages, open, sessionId, running]);
}
