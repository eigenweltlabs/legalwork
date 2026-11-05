import { useEffect, useRef } from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import type { ViewGenerationChunk } from "@legalwork/types/views";
import { useMessageList } from "@/components/chat/message-list-provider";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { reconcileViewGenerations, syncViewGeneration } from "./view-generation-sync";
import { parseDynamicToolUIPart } from "../session/sync/parse-tool-parts";
import type { ThreadStatus } from "@/lib/messages";

export function useViewGenerations(messages: UIMessage[], status: ThreadStatus) {
  const { legalworkClient, workspaceId, sessionId, assistantChat } = useMessageList();
  const open = useRequestPanelTab();
  const latest = useRef(messages);
  latest.current = messages;
  const statusRef = useRef(status);
  statusRef.current = status;
  const chunks = useRef(new Map<string, ViewGenerationChunk>());
  const openRef = useRef(open);
  openRef.current = open;
  const assistantRef = useRef(assistantChat);
  assistantRef.current = assistantChat;
  const openBesideChat = (tab: Parameters<typeof open>[0]) => openRef.current(tab, { besideChat: true });
  const seen = useRef(new WeakSet<DynamicToolUIPart>());
  const pendingIds = messages.flatMap(message => message.parts.flatMap(part => part.type === "dynamic-tool" && (part.toolName === "view_create" || part.toolName === "view_update") && (part.state === "input-streaming" || part.state === "input-available") ? [part.toolCallId] : [])).join("|");
  useEffect(() => {
    if (!legalworkClient || status !== "ready" || !pendingIds) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void legalworkClient.getSessionSnapshot(workspaceId, sessionId).then(({ item }) => {
        if (cancelled || item.status.type !== "idle") return;
        const parts = item.messages.flatMap(message => message.parts.flatMap(part => {
          if (part.type !== "tool" || (part.tool !== "view_create" && part.tool !== "view_update")) return [];
          const parsed = parseDynamicToolUIPart(part);
          return parsed ? [parsed] : [];
        }));
        return reconcileViewGenerations({ serverUrl: legalworkClient.baseUrl, workspaceId, sessionId }, parts);
      }).catch(() => {});
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [legalworkClient, workspaceId, sessionId, status, pendingIds]);
  useEffect(() => {
    if (!legalworkClient) return;
    chunks.current.clear();
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => void legalworkClient.viewGenerationEvents(workspaceId, sessionId, chunk => {
      if (!chunks.current.has(chunk.callId) && chunks.current.size >= 16) chunks.current.delete(chunks.current.keys().next().value!);
      chunks.current.set(chunk.callId, chunk);
      // Only a live transcript call can open a preview. Replayed history cannot reopen saved tabs.
      if (statusRef.current === "ready") return;
      for (const message of latest.current) for (const part of message.parts) {
        if (part.type !== "dynamic-tool" || part.toolCallId !== chunk.callId || (part.state !== "input-streaming" && part.state !== "input-available")) continue;
        void syncViewGeneration({ serverUrl: legalworkClient.baseUrl, workspaceId, sessionId, autoOpen: !assistantRef.current }, {
          ...part, callProviderMetadata: { opencode: { rawInput: chunk.raw } },
        }, openBesideChat);
      }
    }, abort.signal).catch(() => {}).finally(() => { if (!abort.signal.aborted) retry = setTimeout(connect, 2_000); });
    connect();
    return () => { abort.abort(); clearTimeout(retry); };
  }, [legalworkClient, workspaceId, sessionId]);
  useEffect(() => {
    if (!legalworkClient) return;
    for (const message of messages) for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || (part.toolName !== "view_create" && part.toolName !== "view_update") || seen.current.has(part)) continue;
      if (status === "ready" && (part.state === "input-streaming" || part.state === "input-available")) continue;
      seen.current.add(part);
      const chunk = chunks.current.get(part.toolCallId);
      void syncViewGeneration({ serverUrl: legalworkClient.baseUrl, workspaceId, sessionId, autoOpen: !assistantRef.current },
        chunk && part.state === "input-streaming" ? { ...part, callProviderMetadata: { opencode: { rawInput: chunk.raw } } } : part, openBesideChat);
    }
  }, [messages, legalworkClient, workspaceId, sessionId, open, status]);
}
