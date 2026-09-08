import { Component, type ReactNode } from "react";
import { PreviewError } from "./preview";
import { t } from "@/i18n";

// Malformed Office content should not take down the session or its file controls.
export class OfficeEditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <PreviewError message={t("artifact.editor_failed")} />
      : this.props.children;
  }
}
