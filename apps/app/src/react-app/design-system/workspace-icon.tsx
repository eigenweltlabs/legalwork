/** @jsxImportSource react */
import { FolderIcon } from "./folder-icon";

export type WorkspaceIconProps = {
  workspaceId: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
  open?: boolean;
};

export function WorkspaceIcon({ workspaceId, sizeClass = "size-4", open = false }: WorkspaceIconProps) {
  return (
    <FolderIcon data-workspace-icon={workspaceId} className={sizeClass} open={open} />
  );
}
