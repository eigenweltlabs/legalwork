/** Only read/copy operations may run without editing ownership of the source.
 * Copies use separate project write permission checks and never edit the source. Unknown tools fail closed. */
export function isDocumentReadTool(format: "docx" | "office", name: string) {
  return format === "docx"
    ? ["create_comparison_copy", "create_clean_copy", "read_structure", "read_formatting", "inspect_document", "read_document", "read_selection", "find_text", "read_changes", "read_comments", "preview"].includes(name)
    : ["read", "read_presentation", "preview"].includes(name);
}
