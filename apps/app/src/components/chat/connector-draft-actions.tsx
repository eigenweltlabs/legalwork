import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { ArrowUpRight, Send } from "lucide-react";
import { connectorDefinitions } from "@legalwork/types/connectors";
import type { EmailDraft } from "@legalwork/types/email-draft";
import type { CalendarEventDraft } from "@legalwork/types/calendar-event-draft";
import { Button } from "@/components/ui/button";

export function connectorDraftTool(part: ToolUIPart | DynamicToolUIPart, kind: "email" | "calendar") {
  if (getToolName(part) !== "legalwork_extension_call") return false;
  const input = part.input;
  if (!input || typeof input !== "object" || !("extensionId" in input) || !("action" in input)) return false;
  return kind === "email"
    ? ["gmail", "outlook"].includes(String(input.extensionId)) && ["create_draft", "send_draft"].includes(String(input.action))
    : ["google-calendar", "outlook-calendar"].includes(String(input.extensionId)) && ["create_event", "update_event"].includes(String(input.action));
}

/** The assistant's update was refused because the draft changed after it read it. */
export function draftToolConflict(output: unknown) {
  try {
    const payload = draftToolPayload(output);
    return Boolean(payload && typeof payload === "object" && "code" in payload && payload.code === "draft_conflict");
  } catch { return false; }
}

export function draftToolPayload(output: unknown) {
  const value: unknown = typeof output === "string" ? JSON.parse(output) : output;
  const payload = value && typeof value === "object" && "referenceData" in value ? value.referenceData : value;
  return payload && typeof payload === "object" && "result" in payload ? payload.result : payload;
}

export function ConnectorDraftActions({ draft, disabled, onSave, onSend, onOpen }: {
  draft: EmailDraft | CalendarEventDraft; disabled: boolean; onSave: () => void; onSend?: () => void; onOpen: () => void;
}) {
  const provider = connectorDefinitions.find(item => item.id === draft.connectorTarget?.connectorId);
  if (!provider) return null;
  const uncertain = ["saving", "sending", "uncertain"].includes(draft.delivery?.state ?? "");
  const updatingEvent = "googleCalendar" in draft && Boolean(draft.googleCalendar?.update);
  return <div className="ml-auto flex flex-wrap items-center gap-2">
    {uncertain && <span role="alert" className="text-xs text-destructive">Check {provider.name} before retrying this request.</span>}
    {!draft.delivery && <Button size="sm" variant={onSend ? "outline" : "default"} disabled={disabled} onClick={onSave}>{onSend ? `Save draft in ${provider.name}` : updatingEvent ? `Update in ${provider.name}` : `Add to ${provider.name}`}</Button>}
    {draft.delivery && <Button size="sm" variant="outline" disabled={disabled} onClick={onOpen}>Open in {provider.name}<ArrowUpRight className="size-3.5" /></Button>}
    {onSend && draft.delivery?.state !== "sent" && !uncertain && <Button size="sm" disabled={disabled} onClick={onSend}><Send className="size-3.5" />Send</Button>}
  </div>;
}
