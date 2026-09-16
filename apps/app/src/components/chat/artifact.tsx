/** @jsxImportSource react */

import type { UIMessage } from "ai";
import { ArrowUpRightIcon, Inbox } from "lucide-react";

import { ArtifactIcon } from "@/components/chat/artifact-icon";
import type { FiledTask } from "@/components/chat/filed-tasks";
import { t } from "@/i18n";
import { requestOpenTask } from "@/react-app/domains/tasks/task-reference";
import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button";
import {
  type ArtifactItem,
  canOpenArtifact,
  canPreviewArtifact,
  useArtifacts,
  usePreviewArtifact,
} from "@/lib/artifacts";

interface ArtifactButtonProps {
  artifact: ArtifactItem
}

const MAX_ARTIFACT_TITLE_LENGTH = 20;

function compactArtifactTitle(name: string) {
  return name.length > MAX_ARTIFACT_TITLE_LENGTH
    ? `${name.slice(0, MAX_ARTIFACT_TITLE_LENGTH - 1)}…`
    : name;
}

function ArtifactButton({ artifact }: ArtifactButtonProps) {
  const previewArtifact = usePreviewArtifact();
  const canOpen = canOpenArtifact(artifact);
  const canPreview = canPreviewArtifact(artifact);
  const title = compactArtifactTitle(artifact.name);

  const content = (
    <>
      <DescriptiveButtonIcon className="size-5">
        <ArtifactIcon className="size-4 shrink-0" type={artifact.type} />
      </DescriptiveButtonIcon>
      <DescriptiveButtonContent className="min-w-0 flex-none">
        <DescriptiveButtonTitle className="max-w-32 text-xs font-medium" title={artifact.name}>{title}</DescriptiveButtonTitle>
      </DescriptiveButtonContent>
      {canOpen ? <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </>
  );

  if (!canOpen) {
    return (
      <div className="flex h-auto w-fit max-w-full flex-none shrink-0 items-center justify-start gap-1.5 rounded-xl border border-border px-2 py-1.5 text-left whitespace-nowrap">
        {content}
      </div>
    );
  }

  return (
    <DescriptiveButton
      className="w-fit max-w-full flex-none items-center gap-1.5 rounded-xl px-2 py-1.5 whitespace-nowrap"
      onClick={() => previewArtifact(artifact)}
      title={canPreview ? `Preview ${artifact.name}` : `Open ${artifact.name}`}
    >
      {content}
    </DescriptiveButton>
  );
}

/** A task the turn filed, in the same strip and the same shape as a file it produced. */
function TaskButton({ task }: { task: FiledTask }) {
  const name = task.title ?? t("message_list.task_badge_fallback");
  return (
    <DescriptiveButton
      className="w-fit max-w-full flex-none items-center gap-1.5 rounded-xl px-2 py-1.5 whitespace-nowrap"
      onClick={() => requestOpenTask(task.id)}
      title={t("message_list.open_task")}
    >
      <DescriptiveButtonIcon className="size-5">
        <Inbox className="size-4 shrink-0 text-blue-11" />
      </DescriptiveButtonIcon>
      <DescriptiveButtonContent className="min-w-0 flex-none">
        <DescriptiveButtonTitle className="max-w-32 text-xs font-medium" title={name}>{compactArtifactTitle(name)}</DescriptiveButtonTitle>
      </DescriptiveButtonContent>
      <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </DescriptiveButton>
  );
}

interface ArtifactListProps {
  messages: UIMessage[]
  includeTargetFallbacks?: boolean
  /** Tasks the messages filed; shown after the files, in the same strip. */
  tasks?: FiledTask[]
}

export function ArtifactList({ messages, includeTargetFallbacks = false, tasks = [] }: ArtifactListProps) {
  const artifacts = useArtifacts(messages, { includeTargetFallbacks });

  if (artifacts.length === 0 && tasks.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2 md:px-10">
      <div className="no-scrollbar flex min-w-0 flex-nowrap gap-2 overflow-x-auto pb-1">
        {artifacts.map((artifact) => (
          <ArtifactButton key={artifact.id} artifact={artifact} />
        ))}
        {tasks.map((task) => (
          <TaskButton key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
