import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/react-app/design-system/surface";
import { LayoutSectionDescription, LayoutSectionHeader, LayoutSectionTitle } from "../settings-layout";

export function SecretsSectionHeader({ title, description, addLabel, onAdd, disabled }: {
  title: string; description: string; addLabel: string; onAdd?: () => void; disabled?: boolean;
}) {
  return <LayoutSectionHeader>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <LayoutSectionTitle>{title}</LayoutSectionTitle>
        <LayoutSectionDescription className="mt-1">{description}</LayoutSectionDescription>
      </div>
      {onAdd ? <Button size="sm" variant="outline" className="shrink-0" disabled={disabled} onClick={onAdd}><Plus className="size-3.5" />{addLabel}</Button> : null}
    </div>
  </LayoutSectionHeader>;
}

export function SecretsEmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <Surface className="flex min-h-20 items-center gap-3 rounded-xl px-5 py-4 text-sm text-muted-foreground">
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 [&_svg]:size-4">{icon}</span>
    <p>{children}</p>
  </Surface>;
}
