/** @jsxImportSource react */
import { useState } from "react";
import { ArrowDownToLine, FileText, TextSelect } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { useLegalworkControl } from "@/react-app/shell/control/control-provider";
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

export function WordActionsDock() {
  const control = useLegalworkControl();
  const [busy, setBusy] = useState<DockAction | null>(null);

  if (!control || !isWordDocumentHost()) return null;

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

  const items: Array<{
    action: DockAction;
    label: string;
    icon: typeof TextSelect;
    onClick: () => void;
  }> = [
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
