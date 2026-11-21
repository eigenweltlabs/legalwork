import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

export function TimeWorkspaceChat({
  data,
  state,
  proposals,
  pending,
  onAction,
}: {
  data: CaptureState | undefined;
  state: TimesheetState;
  proposals: CaptureProposal[];
  pending: boolean;
  onAction: (action: ChatAction) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
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
  const [scope, setScope] = useState<Scope | "day">("day");
  const [matterId, setMatter] = useState("");
  const [documentId, setDocument] = useState("");
  const [ruleEdit, setRuleEdit] = useState<{ id: string; text: string }>();
  const request = useRef<{ key: string; id: string } | undefined>(undefined);
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
    if (!canSend || sendingRef.current) return;
    let instruction: Extract<ChatAction, { type: "chat" }>["instruction"];
    if (scope === "personal") instruction = { scope };
    if (scope === "matter") instruction = { scope, matterId };
    if (scope === "document") instruction = { scope, matterId, documentId };
    const key = JSON.stringify([draft, instruction]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    sendingRef.current = true;
    setSending(true);
    followLatest.current = true;
    try {
      if (await onAction({ type: "chat", id: request.current.id, text: draft, instruction })) {
        setText("");
        setScope("day");
        setMatter("");
        setDocument("");
        request.current = undefined;
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
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
                  onChange={setText}
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
                                setScope(next);
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
                                setMatter(event.currentTarget.value);
                                setDocument("");
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
                              onChange={(event) => setDocument(event.currentTarget.value)}
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
