import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LayoutSection, LayoutSectionHeader, LayoutSectionTitle, LayoutSectionDescription, LayoutSectionItem, LayoutSectionItemHeader, LayoutSectionItemTitle, LayoutSectionItemHeaderActions } from "../settings-layout";
import { ProjectMetadata } from "../../workspace/project-metadata";
import { defaultAkteFields, useProjectDefaultsStore } from "../../workspace/project-defaults-store";
import { t } from "@/i18n";

export function ProjectDefaultsSection() {
  const savedFields = useProjectDefaultsStore((state) => state.fields);
  const setFields = useProjectDefaultsStore((state) => state.setFields);
  const reset = useProjectDefaultsStore((state) => state.reset);
  const [editing, setEditing] = useState(false);
  const fields = savedFields ?? defaultAkteFields();
  return <LayoutSection>
    <LayoutSectionHeader>
      <LayoutSectionTitle>{t("projects.defaults_title")}</LayoutSectionTitle>
      <LayoutSectionDescription>{t("projects.defaults_hint")}</LayoutSectionDescription>
    </LayoutSectionHeader>
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("projects.defaults_fields")}</LayoutSectionItemTitle>
        <LayoutSectionItemHeaderActions>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>{t("projects.edit")}</Button>
          {savedFields !== null ? <Button size="sm" variant="ghost" onClick={reset}>{t("projects.defaults_reset")}</Button> : null}
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
      <div className="flex flex-wrap gap-2">{fields.map((field) => <Badge key={field.id} variant="secondary" className="font-normal">{field.label}</Badge>)}</div>
    </LayoutSectionItem>
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t("projects.defaults_fields")}</DialogTitle><DialogDescription>{t("projects.defaults_hint")}</DialogDescription></DialogHeader>
        {editing ? <ProjectMetadata definitionsOnly details={{ fields }} onCancel={() => setEditing(false)} onSave={async (next) => { setFields(next); setEditing(false); }} /> : null}
      </DialogContent>
    </Dialog>
  </LayoutSection>;
}
