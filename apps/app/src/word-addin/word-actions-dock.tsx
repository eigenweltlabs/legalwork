/** @jsxImportSource react */
import { useState } from "react";
import { ArrowDownToLine, FileText, TextSelect } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { useLegalworkControl } from "@/react-app/shell/control/control-provider";
import { isExcelWorkbookHost } from "./excel-api";
import { createExcelToolHandlers } from "./excel-document-tools";
import { isPowerPointHost } from "./powerpoint-api";
import { createPowerPointToolHandlers } from "./powerpoint-document-tools";
import {
  insertTextAtSelection,
  isWordDocumentHost,
  readDocumentText,
  readSelectionText,
} from "./office";

/**
 * Keep pasted document context well below model/context limits; the agent
 * can always ask for more targeted excerpts.
 */
const MAX_CONTEXT_CHARS = 100_000;

type DockAction = "selection" | "document" | "insert";

function frameDocumentContext(label: string, text: string, truncated: boolean): string {
  const suffix = truncated ? `\n\n${t("word_addin.context_truncated")}` : "";
  return `${label}\n\n"""\n${text}\n"""${suffix}\n\n`;
}

function matrixToTsv(values: unknown[][]): string {
  return values
    .map((row) => row.map((cell) => (cell == null ? "" : String(cell))).join("\t"))
    .join("\n");
}

export function WordActionsDock() {
  const control = useLegalworkControl();
  const [busy, setBusy] = useState<DockAction | null>(null);

  const isWord = isWordDocumentHost();
  const isExcel = isExcelWorkbookHost();
  const isPpt = isPowerPointHost();
  if (!control || (!isWord && !isExcel && !isPpt)) return null;

  const runAction = async (action: DockAction, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    try {
      await work();
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const sendToComposer = (action: "selection" | "document") =>
    runAction(action, async () => {
      const raw = action === "selection" ? await readSelectionText() : await readDocumentText();
      const text = raw.trim();
      if (!text) {
        toast.info(
          action === "selection"
            ? t("word_addin.empty_selection")
            : t("word_addin.empty_document"),
        );
        return;
      }
      const truncated = text.length > MAX_CONTEXT_CHARS;
      const clipped = truncated ? text.slice(0, MAX_CONTEXT_CHARS) : text;
      const label =
        action === "selection"
          ? t("word_addin.selection_context_label")
          : t("word_addin.document_context_label");
      const result = await control.executeAction("composer.set_text", {
        text: frameDocumentContext(label, clipped, truncated),
      });
      if (!result.ok) {
        toast.warning(result.error);
      }
    });

  const insertLatestReply = () =>
    runAction("insert", async () => {
      const result = await control.executeAction("session.latest_message");
      if (!result.ok) {
        toast.warning(result.error);
        return;
      }
      const payload = result.result as
        | { ok?: boolean; role?: string; text?: string }
        | undefined;
      if (!payload?.ok || payload.role !== "assistant" || !payload.text) {
        toast.info(t("word_addin.no_reply"));
        return;
      }
      // messageToReadableText prefixes assistant messages with a header line.
      const text = payload.text.replace(/^LegalWork\n/, "");
      await insertTextAtSelection(text);
      toast.success(t("word_addin.inserted"));
    });

  const sendExcelToComposer = (action: "selection" | "document") =>
    runAction(action, async () => {
      const handlers = createExcelToolHandlers();
      let label: string;
      let text: string;
      if (action === "selection") {
        const selection = (await handlers.excel_read_selection!({})) as {
          address: string;
          values: unknown[][];
        };
        text = matrixToTsv(selection.values).trim();
        if (!text) {
          toast.info(t("word_addin.empty_selection_cells"));
          return;
        }
        label = `${t("word_addin.excel_selection_context_label")} (${selection.address})`;
      } else {
        const overview = await handlers.excel_read_workbook!({});
        text = JSON.stringify(overview, null, 2);
        label = t("word_addin.excel_overview_context_label");
      }
      const truncated = text.length > MAX_CONTEXT_CHARS;
      const clipped = truncated ? text.slice(0, MAX_CONTEXT_CHARS) : text;
      const result = await control.executeAction("composer.set_text", {
        text: frameDocumentContext(label, clipped, truncated),
      });
      if (!result.ok) {
        toast.warning(result.error);
      }
    });

  const sendPptToComposer = (action: "selection" | "document") =>
    runAction(action, async () => {
      const handlers = createPowerPointToolHandlers();
      let label: string;
      let text: string;
      if (action === "selection") {
        const selection = (await handlers.ppt_read_selection!({})) as {
          selectedText: string | null;
          selectedSlides: number[];
        };
        if (selection.selectedText?.trim()) {
          text = selection.selectedText;
          label = t("word_addin.ppt_selection_context_label");
        } else if (selection.selectedSlides.length > 0) {
          const slideNumber = selection.selectedSlides[0]!;
          const slide = (await handlers.ppt_read_slide!({ slide_number: slideNumber })) as {
            shapes: Array<{ name: string; text: string | null }>;
          };
          text = slide.shapes
            .map((shape) => shape.text)
            .filter((value): value is string => Boolean(value?.trim()))
            .join("\n\n");
          if (!text.trim()) {
            toast.info(t("word_addin.empty_slide"));
            return;
          }
          label = `${t("word_addin.ppt_slide_context_label")} ${slideNumber}:`;
        } else {
          toast.info(t("word_addin.empty_slide"));
          return;
        }
      } else {
        const outline = await handlers.ppt_read_presentation!({});
        text = JSON.stringify(outline, null, 2);
        label = t("word_addin.ppt_outline_context_label");
      }
      const truncated = text.length > MAX_CONTEXT_CHARS;
      const clipped = truncated ? text.slice(0, MAX_CONTEXT_CHARS) : text;
      const result = await control.executeAction("composer.set_text", {
        text: frameDocumentContext(label, clipped, truncated),
      });
      if (!result.ok) {
        toast.warning(result.error);
      }
    });

  type DockItem = {
    action: DockAction;
    label: string;
    icon: typeof TextSelect;
    onClick: () => void;
  };

  const items: DockItem[] = isPpt
    ? [
        {
          action: "selection",
          label: t("word_addin.add_slide"),
          icon: TextSelect,
          onClick: () => void sendPptToComposer("selection"),
        },
        {
          action: "document",
          label: t("word_addin.add_presentation_outline"),
          icon: FileText,
          onClick: () => void sendPptToComposer("document"),
        },
      ]
    : isExcel
    ? [
        {
          action: "selection",
          label: t("word_addin.add_selection"),
          icon: TextSelect,
          onClick: () => void sendExcelToComposer("selection"),
        },
        {
          action: "document",
          label: t("word_addin.add_workbook_overview"),
          icon: FileText,
          onClick: () => void sendExcelToComposer("document"),
        },
      ]
    : [
        {
          action: "selection",
          label: t("word_addin.add_selection"),
          icon: TextSelect,
          onClick: () => void sendToComposer("selection"),
        },
        {
          action: "document",
          label: t("word_addin.add_document"),
          icon: FileText,
          onClick: () => void sendToComposer("document"),
        },
        {
          action: "insert",
          label: t("word_addin.insert_reply"),
          icon: ArrowDownToLine,
          onClick: () => void insertLatestReply(),
        },
      ];

  return (
    <div className="pointer-events-none fixed right-2 top-1/2 z-40 -translate-y-1/2">
      <div className="pointer-events-auto flex flex-col gap-1 rounded-full border border-dls-border bg-dls-surface/95 p-1 shadow-md backdrop-blur">
        {items.map((item) => (
          <Tooltip key={item.action}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                aria-label={item.label}
                disabled={busy !== null && busy !== item.action}
                onClick={item.onClick}
              >
                <item.icon size={15} className={busy === item.action ? "animate-pulse" : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{item.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
