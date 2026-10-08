import { projectFileSourceSchema, type ProjectFileSource } from "@legalwork/types/project-files";
export const PROJECT_FILE_DRAG_TYPE = "application/x-legalwork-project-file";
export function hasProjectFileDrag(data: Pick<DataTransfer, "types">) { return Array.from(data.types).includes(PROJECT_FILE_DRAG_TYPE); }
export function writeProjectFileDrag(data: Pick<DataTransfer, "effectAllowed" | "setData">, source: ProjectFileSource) {
  data.effectAllowed = "copy";
  data.setData(PROJECT_FILE_DRAG_TYPE, JSON.stringify(source));
  data.setData("text/plain", source.name);
}
export function readProjectFileDrag(data: Pick<DataTransfer, "getData">): ProjectFileSource | null {
  try { const result = projectFileSourceSchema.safeParse(JSON.parse(data.getData(PROJECT_FILE_DRAG_TYPE))); return result.success ? result.data : null; }
  catch { return null; }
}
