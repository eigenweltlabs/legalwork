import { Component, type ReactNode } from "react";
import { PreviewError } from "./preview";

// Malformed Office content should not take down the session or its file controls.
export class OfficeEditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <PreviewError message="This file could not be displayed in the editor. You can still open the original file externally." />
      : this.props.children;
  }
}
