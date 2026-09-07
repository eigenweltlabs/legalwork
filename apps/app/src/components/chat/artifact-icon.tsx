/** @jsxImportSource react */
import type { ArtifactType } from "@/lib/artifacts";
import { DocumentIcon } from "@/react-app/design-system/document-icon";

interface ArtifactIconProps {
  className?: string;
  type: ArtifactType;
}

export function ArtifactIcon({ className, type }: ArtifactIconProps) {
  return <DocumentIcon kind={type === "website" ? "browser" : type === "document" ? "word" : type} className={className} />;
}
