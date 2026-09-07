/** @jsxImportSource react */
import { cn } from "@/lib/utils";
import { DocumentIcon } from "@/react-app/design-system/document-icon";
import type { OpenTargetPreview } from "./open-target";

interface ArtifactIconProps {
  type: OpenTargetPreview;
  className?: string;
}

export function ArtifactIcon({ type, className }: ArtifactIconProps) {
  return <DocumentIcon kind={type} className={cn("size-4", className)} />;
}
