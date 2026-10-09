import { useEffect, useState } from "react";
import { ChevronRight, Globe, HardDrive } from "lucide-react";
import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";
import { PermissionApprovalModal } from "@/react-app/domains/session/chat/permission-approval-modal";
import { networkApprovalContent } from "./network-approval-content";

export function HostApprovalListener() {
  const [request, setRequest] = useState<HostApprovalRequest | null>(null);
  useEffect(() => window.__LEGALWORK_ELECTRON__?.approvals?.onChange(setRequest), []);
  if (!request) return null;
  const network = request.network ? networkApprovalContent(request.network) : null;
  const command = request.action === "sandbox.bash";
  const read = request.action === "sandbox.read";
  const title = network?.action ?? t(command ? "session.permission_title_bash" : read ? "session.permission_title_read" : "sandbox.approval_change_title");
  const message = network?.description ?? t(command ? "session.permission_message_bash" : read ? "session.permission_message_read" : "sandbox.approval_local_description");
  const target = network?.destination ?? (command ? request.summary.split("\n\n").slice(1).join("\n\n") : request.paths.join("\n") || request.summary);
  const Icon = network ? Globe : HardDrive;
  const details = [request.summary, ...request.paths, `Workspace: ${request.workspaceId}`, `Source: ${request.actor.type}`, ...(request.actor.clientId ? [`Client: ${request.actor.clientId}`] : [])].join("\n\n");
  return <PermissionApprovalModal key={request.id}
    permission={{ id: request.id, sessionID: request.workspaceId, permission: request.action,
      patterns: request.paths, metadata: {}, always: [], receivedAt: request.createdAt, protocol: "legacy" }}
    allowForSession={false}
    respondPermission={(_id, reply) => window.__LEGALWORK_ELECTRON__?.approvals?.reply(request.id, reply === "once" ? "allow" : "deny")}
    review={{ title, message, hint: t("sandbox.approval_once"), content: <>
      <div className="rounded-[20px] border border-dls-border bg-dls-surface p-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-dls-secondary">
          <Icon size={13} />
          {t(network ? "sandbox.approval_destination" : command ? "session.permission_detail_command" : "session.permission_detail_files")}
        </div>
        <div dir="auto" className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm font-medium leading-6 text-dls-text">{target}</div>
        {network?.resource && network.resource !== "/" ? <div dir="auto" className="mt-1 break-all text-xs text-dls-secondary">{network.resource}</div> : null}
        {network ? <p className="mt-2 text-xs leading-5 text-dls-secondary">{network.context}</p> : null}
      </div>
      {network?.sent ? <div className="rounded-[20px] border border-dls-border bg-dls-surface p-4">
        <div className="text-[12px] font-medium text-dls-secondary">{t("sandbox.approval_sent")}</div>
        <div dir="auto" className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-dls-border bg-dls-hover/45 px-3 py-2 text-sm leading-5 text-dls-text">{network.sent}</div>
      </div> : null}
      <details className="group rounded-[18px] border border-dls-border bg-dls-surface px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-dls-text">
          {t(network ? "sandbox.approval_technical_details" : "session.details_label")}
          <ChevronRight size={15} className="text-dls-secondary transition-transform group-open:rotate-90" />
        </summary>
        <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-dls-border bg-dls-hover/45 px-3 py-2.5 text-[12px] leading-5 text-dls-secondary">{details}</pre>
      </details>
    </> }} />;
}
