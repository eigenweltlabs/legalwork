import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTile, Surface } from "@/react-app/design-system/surface";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { t } from "@/i18n";
import { AssistantDelegationResultSchema } from "@legalwork/types/main-assistant";

export const isDelegationTool = (part: ToolUIPart | DynamicToolUIPart) => getToolName(part) === "legalwork_assistant_delegate";
export function parseDelegationCard(output: unknown) {
  try {
    const result = AssistantDelegationResultSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output);
    return result.success ? result.data.delegation : null;
  } catch { return null; }
}
export function DelegationCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const navigate = useNavigate();
  const delegation = part.state === "output-available" ? parseDelegationCard(part.output) : null;
  if (part.state !== "output-available" && part.state !== "output-error") return <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("assistant.delegating")}</p>;
  if (!delegation) return <p role="alert" className="py-3 text-sm text-destructive">{t("assistant.delegation_failed")}</p>;
  return <Surface className="my-3 flex min-w-0 items-start gap-3 p-4">
    <IconTile variant="inset"><FolderOpen /></IconTile>
    <div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{delegation.projectName}</p><p className="mt-1 break-words text-sm font-medium">{delegation.title}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{delegation.scope}</p><p className="mt-2 text-xs text-muted-foreground">{t(delegation.status === "started" ? "assistant.work_started" : "assistant.delivery_unconfirmed")}</p></div>
    <Button variant="outline" size="sm" onClick={() => navigate(workspaceSessionRoute(delegation.workspaceId, delegation.sessionId))}>{t("assistant.open_chat")}<ArrowUpRight className="size-3.5" /></Button>
  </Surface>;
}
