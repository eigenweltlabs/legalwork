"use client"

import { Tool } from "@/components/ui/tool"
import type { SkillToolPart } from "@/lib/build-in-tools"
import { t } from "@/i18n"

interface SkillToolProps {
  part: SkillToolPart
}

function getSkillToolTitle(part: SkillToolPart): string | null {
  const name = part.input?.name?.trim() ?? ""

  if (part.state === "output-error") {
    return name ? t("tool.load_skill_attempted_named", { name }) : t("tool.load_skill_attempted")
  }

  if (part.state !== "output-available") {
    return null
  }

  return name ? t("tool.load_skill", { name }) : t("tool.load_skill_generic")
}

export function SkillTool({ part }: SkillToolProps) {
  return <Tool toolPart={part} title={getSkillToolTitle(part) ?? undefined} />
}
