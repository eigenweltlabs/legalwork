/** Only these tools may run without editing ownership. Unknown tools fail closed. */
export function isDocumentReadTool(format: "docx" | "office", name: string) {
  return format === "docx"
    ? ["read_document", "read_selection", "find_text", "read_changes", "read_comments"].includes(name)
    : ["read", "read_presentation", "preview"].includes(name);
}
