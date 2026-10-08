import { projectFileSourceSchema, type ProjectFileSource } from "@legalwork/types/project-files";
export const PROJECT_FILE_DRAG_TYPE = "application/x-legalwork-project-file";
export const PROJECT_FILES_DRAG_TYPE = "application/x-legalwork-project-files";
export const projectFileSourceKey = (source: ProjectFileSource) => JSON.stringify([source.projectId, source.workspaceId, source.connectionId, source.path]);
export function hasProjectFileDrag(data: Pick<DataTransfer, "types">) { return Array.from(data.types).some(type => type === PROJECT_FILE_DRAG_TYPE || type === PROJECT_FILES_DRAG_TYPE); }
export function writeProjectFileDrag(data: Pick<DataTransfer, "effectAllowed" | "setData">, source: ProjectFileSource) {
  data.effectAllowed = "copy";
  data.setData(PROJECT_FILE_DRAG_TYPE, JSON.stringify(source));
  data.setData("text/plain", source.name);
}
export function writeProjectFilesDrag(data: Pick<DataTransfer, "effectAllowed" | "setData" | "clearData">, sources: ProjectFileSource[]) {
  // Don't leave a single-file payload behind for older drop targets to import just one item.
  data.clearData();
  data.effectAllowed = "copy";
  data.setData(PROJECT_FILES_DRAG_TYPE, JSON.stringify(sources));
  data.setData("text/plain", sources.map(source => source.name).join("\n"));
}
export function readProjectFilesDrag(data: Pick<DataTransfer, "getData">): ProjectFileSource[] {
  const multiple = data.getData(PROJECT_FILES_DRAG_TYPE);
  if (!multiple) { const single = readProjectFileDrag(data); return single ? [single] : []; }
  try {
    const result = projectFileSourceSchema.array().min(1).safeParse(JSON.parse(multiple));
    return result.success ? [...new Map(result.data.map(source => [projectFileSourceKey(source), source])).values()] : [];
  } catch { return []; }
}
export function readProjectFileDrag(data: Pick<DataTransfer, "getData">): ProjectFileSource | null {
  try { const result = projectFileSourceSchema.safeParse(JSON.parse(data.getData(PROJECT_FILE_DRAG_TYPE))); return result.success ? result.data : null; }
  catch { return null; }
}
