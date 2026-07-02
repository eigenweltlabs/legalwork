/**
 * Minimal PowerPoint.js bridge for the task pane, mirroring office.ts /
 * excel-api.ts: the PowerPoint global from office.js is typed structurally
 * (only the members we use).
 */
import { isOfficeApiSupported, officeHostName } from "./office";

export type PptTextRange = {
  text: string;
  load: (properties: string) => void;
};

export type PptTextFrame = {
  hasText: boolean;
  textRange: PptTextRange;
  load: (properties: string) => void;
};

export type PptShape = {
  id: string;
  name: string;
  textFrame: PptTextFrame;
  load: (properties: string) => void;
};

export type PptShapeCollection = {
  items: PptShape[];
  load: (properties: string) => void;
  addTextBox: (
    text: string,
    options?: { left?: number; top?: number; width?: number; height?: number },
  ) => PptShape;
};

export type PptSlide = {
  id: string;
  shapes: PptShapeCollection;
  load: (properties: string) => void;
};

export type PptSlideCollection = {
  items: PptSlide[];
  load: (properties: string) => void;
  add: () => void;
  getCount: () => { value: number };
};

export type PptPresentation = {
  slides: PptSlideCollection;
  getSelectedSlides: () => PptSlideCollection;
  getSelectedTextRangeOrNullObject: () => PptTextRange & { isNullObject: boolean };
};

export type PptRunContext = {
  presentation: PptPresentation;
  sync: () => Promise<void>;
};

type PowerPointNamespace = {
  run: <T>(batch: (context: PptRunContext) => Promise<T>) => Promise<T>;
};

function powerPointGlobal(): PowerPointNamespace | undefined {
  return (window as unknown as { PowerPoint?: PowerPointNamespace }).PowerPoint;
}

/** True when running inside PowerPoint with its JavaScript API available. */
export function isPowerPointHost(): boolean {
  return officeHostName() === "powerpoint" && Boolean(powerPointGlobal());
}

export function isPowerPointApiSupported(version: string): boolean {
  return isOfficeApiSupported("PowerPointApi", version);
}

/** Run a PowerPoint.run batch. Throws outside of PowerPoint. */
export function powerPointRun<T>(batch: (context: PptRunContext) => Promise<T>): Promise<T> {
  const powerPoint = powerPointGlobal();
  if (!powerPoint) {
    throw new Error("The PowerPoint JavaScript API is not available in this context.");
  }
  return powerPoint.run(batch);
}
