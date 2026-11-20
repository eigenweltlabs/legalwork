import { useRef, useState, type FormEvent } from "react";
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

export function TimeWorkspaceChat({
  data,
  state,
  proposals,
  pending,
  aiEnabled,
  onAction,
}: {
  data: CaptureState | undefined;
  state: TimesheetState;
  proposals: CaptureProposal[];
  pending: boolean;
  aiEnabled: boolean;
  onAction: (action: ChatAction) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !text.trim() ||
      !validScope ||
      !data ||
      pending ||
      (scope === "day" && !aiEnabled)
    )
      return;
    let instruction: Extract<ChatAction, { type: "chat" }>["instruction"];
    if (scope === "personal") instruction = { scope };
    if (scope === "matter") instruction = { scope, matterId };
    if (scope === "document") instruction = { scope, matterId, documentId };
    const key = JSON.stringify([text.trim(), instruction]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    if (
      await onAction({
        type: "chat",
        id: request.current.id,
        text: text.trim(),
        instruction,
      })
    ) {
      setText("");
      request.current = undefined;
    }
  }
  return (
    <>
      <p className="time-workspace-note">{t("timeWorkspace.chatHint")}</p>
      {!data ? (
        <p className="time-workspace-note">
          {t("timeWorkspace.chatUnavailable")}
        </p>
      ) : (
        <>
          <ol className="time-workspace-messages" aria-live="polite">
            {data.chat?.map((message) => (
              <li key={message.id} data-role={message.role}>
                <strong>
                  {t(
                    message.role === "user"
                      ? "timeWorkspace.you"
                      : "timeWorkspace.assistant",
                  )}
                </strong>
                <p>{message.text}</p>
              </li>
            ))}
          </ol>
          <form
            className="time-workspace-form"
            onSubmit={(event) => void submit(event)}
          >
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
            <label>
              {t(
                scope === "day"
                  ? "timeWorkspace.message"
                  : "timeWorkspace.rule",
              )}
              <textarea
                rows={3}
                value={text}
                maxLength={2000}
                disabled={pending}
                onChange={(event) => setText(event.currentTarget.value)}
              />
            </label>
            {scope === "day" && !aiEnabled && (
              <p className="time-workspace-note">
                {t("timeWorkspace.enableForChat")}
              </p>
            )}
            <Button
              size="sm"
              type="submit"
              disabled={
                pending ||
                !text.trim() ||
                !validScope ||
                (scope === "day" && !aiEnabled)
              }
            >
              {t(
                scope === "day"
                  ? "timeWorkspace.send"
                  : "timeWorkspace.saveRule",
              )}
            </Button>
          </form>
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
        </>
      )}
    </>
  );
}
