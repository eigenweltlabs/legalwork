import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "@/components/chat/message-list";
import { PendingStatus } from "@/components/chat/pending-status";
import { ComposerSendButton, ComposerSurface } from "../session/surface/composer/composer-surface";
import { LexicalPromptEditor } from "../session/surface/composer/editor";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type {
  CaptureAction,
  CaptureProposal,
  CaptureState,
} from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { proposalAssignment } from "./time-record-values";
import { proposalTitle } from "./timesheet-workday-view";

const scopes = {
  personal: "timeWorkspace.personal",
  matter: "timeWorkspace.matterRule",
  document: "timeWorkspace.documentRule",
};
type Scope = keyof typeof scopes;
type ChatAction = Extract<CaptureAction, { type: "chat" | "instruction" }>;
const noMentions = {};
const messageLimit = 2000;
type ChatDraft = {
  text: string;
  scope: Scope | "day";
  matterId: string;
  documentId: string;
  sending: boolean;
  request?: { key: string; id: string };
};
const emptyChatDraft: ChatDraft = { text: "", scope: "day", matterId: "", documentId: "", sending: false };

export function TimeWorkspaceChat({
  draftKey,
  data,
  state,
  proposals,
  pending,
  onAction,
}: {
  draftKey: QueryKey;
  data: CaptureState | undefined;
  state: TimesheetState;
  proposals: CaptureProposal[];
  pending: boolean;
  onAction: (action: ChatAction) => Promise<boolean>;
}) {
  const cache = useQueryClient();
  // Match the private workday cache's account/day scope, including when this tab unmounts.
  useLayoutEffect(() => {
    cache.setQueryDefaults(["timekeeping-chat-draft"], { gcTime: Infinity });
  }, [cache]);
  const subscribe = useCallback((listener: () => void) => cache.getQueryCache().subscribe(listener), [cache]);
  const composer = useSyncExternalStore(subscribe, () => cache.getQueryData<ChatDraft>(draftKey) ?? emptyChatDraft);
  const { text, scope, matterId, documentId, sending } = composer;
  function updateDraft(changes: Partial<ChatDraft>) {
    cache.setQueryData<ChatDraft>(draftKey, current => ({ ...(current ?? emptyChatDraft), ...changes }));
  }
  const scroll = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const latest = data?.chat?.at(-1)?.id;
  const chatAvailable = Boolean(data);
  const scrollToLatest = useCallback(() => {
    const element = scroll.current;
    if (element && followLatest.current) element.scrollTop = element.scrollHeight;
  }, []);
  useLayoutEffect(scrollToLatest, [latest, sending, scrollToLatest]);
  useEffect(() => {
    if (!scroll.current || !transcript.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(scroll.current);
    observer.observe(transcript.current);
    return () => observer.disconnect();
  }, [chatAvailable, scrollToLatest]);
  const [ruleEdit, setRuleEdit] = useState<{ id: string; text: string }>();
  const documentOptions = new Map<string, string>();
  for (const proposal of proposals) {
    const matter = proposalAssignment(proposal, state).matter;
    if (proposal.documentId && matter?.id === matterId)
      documentOptions.set(proposal.documentId, proposalTitle(proposal));
  }
  const validScope =
    scope === "day" ||
    scope === "personal" ||
    Boolean(
      state.matters.some((matter) => matter.id === matterId) &&
      (scope === "matter" || documentOptions.has(documentId)),
    );
  const draft = text.trim();
  const exceedsLimit = draft.length > messageLimit;
  const canSend = Boolean(data && draft && !exceedsLimit && validScope && !pending && !sending);
  const promptLabel = t(scope === "day" ? "timeWorkspace.message" : "timeWorkspace.rule");

  async function submit() {
    if (!canSend || cache.getQueryData<ChatDraft>(draftKey)?.sending) return;
    let instruction: Extract<ChatAction, { type: "chat" }>["instruction"];
    if (scope === "personal") instruction = { scope };
    if (scope === "matter") instruction = { scope, matterId };
    if (scope === "document") instruction = { scope, matterId, documentId };
    const key = JSON.stringify([draft, instruction]);
    const request = composer.request?.key === key ? composer.request : { key, id: crypto.randomUUID() };
    updateDraft({ request, sending: true });
    followLatest.current = true;
    try {
      if (await onAction({ type: "chat", id: request.id, text: draft, instruction })) {
        cache.setQueryData<ChatDraft>(draftKey, current =>
          current?.request?.id === request.id ? emptyChatDraft : current);
      }
    } finally {
      cache.setQueryData<ChatDraft>(draftKey, current =>
        current?.request?.id === request.id ? { ...current, sending: false } : current);
    }
  }

  return (
    <>
      {!data ? (
        <p className="time-workspace-note">{t("timeWorkspace.chatUnavailable")}</p>
      ) : (
        <>
          <div
            ref={scroll}
            role="log"
            aria-label={t("timeWorkspace.chat")}
            className="time-workspace-chat-transcript"
            tabIndex={0}
            onScroll={event => {
              const element = event.currentTarget;
              if (element.clientHeight)
                followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
            }}
          >
            <div ref={transcript}>
              <MessageList plainText messages={data.chat ?? []} />
              {sending && <PendingStatus preparing />}
            </div>
          </div>
          <div className="time-workspace-chat-controls">
            <form
              data-workday-chat-composer=""
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <ComposerSurface className="time-workspace-chat-composer border-dls-border">
                <LexicalPromptEditor
                  value={text}
                  mentions={noMentions}
                  disabled={pending || sending}
                  submitDisabled={!canSend}
                  placeholder={promptLabel}
                  ariaLabel={promptLabel}
                  onChange={text => updateDraft({ text })}
                  onSubmit={submit}
                />
                <div className="time-workspace-chat-actions">
                  <Popover>
                    <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm"
                      aria-label={t("timeWorkspace.chatPurpose")} title={t(scope === "day" ? "timeWorkspace.chatPurpose" : scopes[scope])} />}>
                      <Ellipsis size={18} aria-hidden="true" />
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" className="w-[min(24rem,calc(100vw-2rem))] max-h-[65vh] overflow-auto"
                      data-workday-chat-options="">
                      <div className="time-workspace-chat-scope">
                        <label>
                          {t("timeWorkspace.chatPurpose")}
                          <select
                            value={scope}
                            disabled={pending}
                            onChange={(event) => {
                              const next = event.currentTarget.value;
                              if (
                                next === "day" ||
                                next === "personal" ||
                                next === "matter" ||
                                next === "document"
                              )
                                updateDraft({ scope: next });
                            }}
                          >
                            <option value="day">{t("timeWorkspace.dayCorrection")}</option>
                            <option value="personal">{t(scopes.personal)}</option>
                            <option value="matter">{t(scopes.matter)}</option>
                            <option value="document">{t(scopes.document)}</option>
                          </select>
                        </label>
                        {(scope === "matter" || scope === "document") && (
                          <label>
                            {t("timesheets.workday.matter")}
                            <select
                              value={matterId}
                              disabled={pending}
                              onChange={(event) => {
                                updateDraft({ matterId: event.currentTarget.value, documentId: "" });
                              }}
                            >
                              <option value="">{t("timesheets.workday.choose")}</option>
                              {state.matters.map((matter) => (
                                <option key={matter.id} value={matter.id}>
                                  {matter.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {scope === "document" && (
                          <label>
                            {t("timeWorkspace.document")}
                            <select
                              value={documentId}
                              disabled={pending || !documentOptions.size}
                              onChange={(event) => updateDraft({ documentId: event.currentTarget.value })}
                            >
                              <option value="">{t("timeWorkspace.chooseDocument")}</option>
                              {[...documentOptions].map(([id, title]) => (
                                <option key={id} value={id}>
                                  {title}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                      <details className="time-workspace-rules">
                        <summary>
                          {t("timeWorkspace.rules")} {data.instructions?.length || ""}
                        </summary>
                        {!data.instructions?.length && (
                          <p className="time-workspace-note">
                            {t("timeWorkspace.noRules")}
                          </p>
                        )}
                        <ul>
                          {data.instructions?.map((instruction) => {
                            const matter = state.matters.find(
                              (item) => item.id === instruction.matterId,
                            );
                            const doc = proposals.find(
                              (proposal) =>
                                proposal.documentId &&
                                proposal.documentId === instruction.documentId &&
                                proposalAssignment(proposal, state).matter?.id ===
                                  instruction.matterId,
                            );
                            return (
                              <li key={instruction.id}>
                                <small>
                                  {[
                                    t(scopes[instruction.scope]),
                                    matter?.name,
                                    doc && proposalTitle(doc),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </small>
                                {ruleEdit?.id === instruction.id ? (
                                  <form
                                    className="time-workspace-form"
                                    onSubmit={async (event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      if (
                                        ruleEdit.text.trim() &&
                                        (await onAction({
                                          type: "instruction",
                                          id: instruction.id,
                                          text: ruleEdit.text.trim(),
                                        }))
                                      )
                                        setRuleEdit(undefined);
                                    }}
                                  >
                                    <label>
                                      {t("timeWorkspace.rule")}
                                      <textarea
                                        rows={3}
                                        value={ruleEdit.text}
                                        maxLength={2000}
                                        disabled={pending}
                                        onChange={(event) =>
                                          setRuleEdit({
                                            id: instruction.id,
                                            text: event.currentTarget.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <div className="time-workspace-actions">
                                      <Button
                                        type="submit"
                                        size="sm"
                                        disabled={pending || !ruleEdit.text.trim()}
                                      >
                                        {t("timeWorkspace.saveRule")}
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        disabled={pending}
                                        onClick={() => setRuleEdit(undefined)}
                                      >
                                        {t("timesheets.workday.cancel")}
                                      </Button>
                                    </div>
                                  </form>
                                ) : (
                                  <p>{instruction.text}</p>
                                )}
                                {ruleEdit?.id !== instruction.id && (
                                  <div className="time-workspace-actions">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      disabled={pending}
                                      onClick={() =>
                                        setRuleEdit({
                                          id: instruction.id,
                                          text: instruction.text,
                                        })
                                      }
                                    >
                                      {t("timesheets.workday.correct")}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      disabled={pending}
                                      onClick={() =>
                                        void onAction({
                                          type: "instruction",
                                          id: instruction.id,
                                          text: null,
                                        })
                                      }
                                    >
                                      {t("timeWorkspace.removeRule")}
                                    </Button>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    </PopoverContent>
                  </Popover>
                  <div className="time-workspace-chat-send">
                    {exceedsLimit && <output>{draft.length} / {messageLimit}</output>}
                    <ComposerSendButton
                      type="submit"
                      disabled={!canSend}
                      label={t(scope === "day" ? "timeWorkspace.send" : "timeWorkspace.saveRule")}
                    />
                  </div>
                </div>
              </ComposerSurface>
            </form>
          </div>
        </>
      )}
    </>
  );
}
