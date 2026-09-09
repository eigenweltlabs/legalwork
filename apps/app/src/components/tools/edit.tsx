"use client"

import { Tool } from "@/components/ui/tool"
import type { EditToolPart } from "@/lib/build-in-tools"
import { parseFilename } from "@/components/tools/path"
import { t } from "@/i18n"

interface EditToolProps {
  part: EditToolPart
}

function getEditToolTitle(part: EditToolPart): string | null {
  const filename = parseFilename(part.input.filePath)

  if (part.state === "output-error") {
    return t("tool.update_attempted", { file: filename })
  }

  if (part.state !== "output-available") {
    return null
  }

  return t("tool.updated_filename", { file: filename })
}

export function EditTool({ part }: EditToolProps) {
  return <Tool toolPart={part} title={getEditToolTitle(part) ?? undefined} />
}
