"use client"

import { Tool } from "@/components/ui/tool"
import type { LspInput, LspToolPart } from "@/lib/build-in-tools"
import { parseFilename, toolDisplayTitle } from "@/components/tools/path"
import { t } from "@/i18n"

interface LspToolProps {
  part: LspToolPart
}

const LSP_OPERATION_LABELS: Record<LspInput["operation"], string> = {
  get goToDefinition() { return t("tool.lsp_go_to_definition") },
  get findReferences() { return t("tool.lsp_find_references") },
  get hover() { return t("tool.lsp_hover") },
  get documentSymbol() { return t("tool.lsp_document_symbol") },
  get workspaceSymbol() { return t("tool.lsp_workspace_symbol") },
  get goToImplementation() { return t("tool.lsp_go_to_implementation") },
  get prepareCallHierarchy() { return t("tool.lsp_prepare_call_hierarchy") },
  get incomingCalls() { return t("tool.lsp_incoming_calls") },
  get outgoingCalls() { return t("tool.lsp_outgoing_calls") },
}

function getLspToolTitle(part: LspToolPart): string | null {
  const filename = parseFilename(part.input.filePath)
  const operation = LSP_OPERATION_LABELS[part.input.operation]

  if (part.state === "output-error") {
    return `${operation} attempted in ${filename}`
  }

  if (part.state !== "output-available") {
    return null
  }

  return `${operation} in ${filename}`
}

function getLspToolDetail(part: LspToolPart): string | undefined {
  const line = part.input.line
  const character = part.input.character
  const query = part.input.query?.trim()

  const location = `L${line}:${character}`
  if (query) {
    return `${location} · ${query}`
  }

  return location
}

export function LspTool({ part }: LspToolProps) {
  return (
    <Tool
      toolPart={part}
      title={toolDisplayTitle(getLspToolTitle(part), getLspToolDetail(part))}
    />
  )
}
