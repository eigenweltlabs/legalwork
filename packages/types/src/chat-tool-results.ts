import { z } from "zod";
import { ReviewToolCardSchema } from "./reviews.js";
import { JevSearchCardSchema } from "./corpus.js";
import { CalculationCardSchema } from "./calculation.js";
import { EmailDraftSchema } from "./email-draft.js";
import { CalendarEventDraftSchema } from "./calendar-event-draft.js";
import { ScheduledTaskSchema } from "./scheduled-tasks.js";
import { projectContentsSchema } from "./workspace.js";
import { WikiSuggestionSchema } from "./wiki-suggestions.js";
import { ViewPreviewSchema, ViewRecordSchema } from "./views.js";
import { AssistantDelegationResultSchema, AssistantNameResultSchema, AssistantReactionResultSchema, AssistantSharedFileResultSchema } from "./main-assistant.js";

const callSchema = z.object({ tool: z.string(), status: z.enum(["running", "completed", "error"]), input: z.unknown().optional() });
const email = z.object({ draft: EmailDraftSchema.extend({ subject: EmailDraftSchema.shape.subject.unwrap() }) });
const calendar = z.object({ draft: CalendarEventDraftSchema });
const schemas: Record<string, z.ZodType> = {
  legalwork_assistant_share_file: AssistantSharedFileResultSchema,
  legalwork_assistant_delegate: AssistantDelegationResultSchema,
  legalwork_assistant_set_name: AssistantNameResultSchema,
  legalwork_review_create: ReviewToolCardSchema, legalwork_review_launch: ReviewToolCardSchema,
  legalwork_review_edit: ReviewToolCardSchema, legalwork_review_start: ReviewToolCardSchema, legalwork_review_cancel: ReviewToolCardSchema,
  legalwork_jev_corpus_question: JevSearchCardSchema,
  legalwork_calculation_present: CalculationCardSchema,
  legalwork_email_draft: email, legalwork_email_draft_update: email,
  legalwork_calendar_event_draft: calendar, legalwork_calendar_event_draft_update: calendar,
  legalwork_schedule_create: z.object({ task: ScheduledTaskSchema }), legalwork_schedule_update: z.object({ task: ScheduledTaskSchema }),
  legalwork_project_list: projectContentsSchema,
  legalwork_task_create: z.object({ ok: z.literal(true), task: z.object({ id: z.string().min(1), title: z.string().nullable().optional(), origin: z.enum(["desktop", "intake"]) }) }),
  wiki_suggest: z.object({ suggestion: WikiSuggestionSchema }), wiki_suggestion_update: z.object({ suggestion: WikiSuggestionSchema }), wiki_write: z.object({ suggestion: WikiSuggestionSchema }),
  view_create: ViewPreviewSchema, view_update: ViewPreviewSchema, view_read: z.object({ view: ViewRecordSchema }),
};

function schemaFor(tool: string, input: unknown) {
  if (tool === "legalwork_assistant_briefing") return z.object({ action: z.literal("create") }).safeParse(input).success ? z.object({ task: ScheduledTaskSchema }) : undefined;
  if (tool !== "legalwork_extension_call") return Object.hasOwn(schemas, tool) ? schemas[tool] : undefined;
  const action = z.object({ extensionId: z.string(), action: z.string() }).safeParse(input);
  if (!action.success) return;
  if (["gmail", "outlook"].includes(action.data.extensionId) && ["create_draft", "send_draft"].includes(action.data.action)) return email;
  if (["google-calendar", "outlook-calendar"].includes(action.data.extensionId) && ["create_event", "update_event"].includes(action.data.action)) return calendar;
}

/** Validate actual native tool output before preserving it as a UI result. */
export function chatToolResult(tool: string, input: unknown, output: unknown): unknown {
  let payload = output;
  if (payload && typeof payload === "object" && "referenceData" in payload) payload = payload.referenceData;
  if (payload && typeof payload === "object" && "result" in payload) payload = payload.result;
  const failed = Boolean(output && typeof output === "object" && "ok" in output && output.ok === false)
    || Boolean(payload && typeof payload === "object" && "ok" in payload && payload.ok === false);
  if (failed && tool !== "legalwork_assistant_delegate") return;
  const schema = tool === "legalwork_assistant_react" ? AssistantReactionResultSchema : schemaFor(tool, input);
  const parsed = schema?.safeParse(payload);
  return parsed?.success ? parsed.data : undefined;
}

export type CodeModeWidgetResult = { callId: string; tool: string; input: unknown; output: unknown };

/** Hide only metadata-attested model reminders, preserving native content. */
export function toolDisplayText(content: ReadonlyArray<{ type: string; text?: string }>, metadata?: Record<string, unknown>): string {
  const states = metadata?.legalworkSystemReminders;
  const reminders = new Set(states && typeof states === "object" && !Array.isArray(states)
    ? Object.entries(states).flatMap(([topic, state]) => typeof state === "string"
      ? [`<system-reminder topic="${topic}">\n${state}\n</system-reminder>`] : []) : []);
  return content.flatMap(item => item.type === "text" && item.text !== undefined && !reminders.has(item.text) ? [item.text] : []).join("\n");
}

/** Presentation only. Require a recorded successful call and its domain's result
 * schema, never a tool name guessed from model-authored source or output text. */
export function codeModeWidgetResults(callId: string, metadata: Record<string, unknown> | undefined, output: unknown): CodeModeWidgetResult[] {
  if (!Array.isArray(metadata?.toolCalls)) return [];
  const calls = metadata.toolCalls.flatMap((value: unknown) => {
    const call = callSchema.safeParse(value);
    return call.success ? [call.data] : [];
  });
  const result: CodeModeWidgetResult[] = [];
  const recorded = z.array(z.object({ tool: z.string(), input: z.unknown().optional(), output: z.unknown() })).safeParse(metadata.legalworkToolResults);
  if (recorded.success) for (const item of recorded.data) {
    const payload = chatToolResult(item.tool, item.input, item.output);
    const index = calls.findIndex(call => call.tool === item.tool && call.status === "completed");
    if (payload === undefined || index < 0) continue;
    calls.splice(index, 1);
    result.push({ callId, ...item, input: item.input, output: payload });
  }
  // Older messages lack the verified result record. Preserve their existing cards.
  if (!Object.hasOwn(metadata, "legalworkToolResults")) {
    let parsed: unknown = output;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!value || typeof value !== "object") continue;
      let payload = "referenceData" in value ? value.referenceData : value;
      if (payload && typeof payload === "object" && "result" in payload) payload = payload.result;
      const failed = "ok" in value && value.ok === false || Boolean(payload && typeof payload === "object" && "ok" in payload && payload.ok === false);
      // An unconfirmed delegation has a real created chat and a warning card.
      // Other failed results must never become successful-looking widgets.
      const index = calls.findIndex(call => call.status === "completed"
        && (!failed || call.tool === "legalwork_assistant_delegate" && payload && typeof payload === "object" && "ok" in payload && payload.ok === false)
        && schemaFor(call.tool, call.input)?.safeParse(payload).success);
      if (index < 0) continue;
      const [call] = calls.splice(index, 1);
      result.push({ callId, tool: call.tool, input: call.input, output: payload });
    }
  }
  // Keep the outer activity row when other calls have no card. Otherwise the
  // first card replaces its live placeholder, preserving existing save sources.
  return result.map((item, index) => ({ ...item, callId: calls.length || index ? `${callId}:widget:${index}` : callId }));
}
