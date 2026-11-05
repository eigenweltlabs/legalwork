import { z } from "zod";

const index = z.number().int().nonnegative().safe();
export const historyImageSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user-file"), fileIndex: index }).strict(),
  z.object({ kind: z.literal("tool-content"), toolIndex: index, contentIndex: index }).strict(),
]);
export const historyImageReference = z.object({
  sessionID: z.string().min(1), messageID: z.string().min(1), selector: historyImageSelector,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const historyImageMetadata = z.object({
  reference: historyImageReference, mime: z.string(), name: z.string().optional(),
  bytes: z.number().int().nonnegative().safe(), provenance: z.literal("stored-session-image"),
});
export const historyImageListInput = z.object({ sessionID: z.string().min(1).optional(), cursor: z.string().min(1).optional() }).strict();
export const historyImagePage = z.object({
  sessionID: z.string(), images: z.array(historyImageMetadata),
  cursor: z.object({ next: z.string().nullable(), previous: z.string().nullable() }),
  coverage: z.literal("native-message-page"),
  parent: z.discriminatedUnion("status", [
    z.object({ status: z.literal("none") }),
    z.object({ status: z.literal("available"), sessionID: z.string() }),
    z.object({ status: z.literal("unavailable") }),
  ]),
});
// This wire form stays between the authorized server and native plugin. The
// model receives metadata and a file content part, never a base64 JSON echo.
export const historyImagePayload = z.object({ image: historyImageMetadata, uri: z.string() }).refine(
  value => /^image\/[a-z0-9.+-]+$/i.test(value.image.mime) && value.uri.startsWith(`data:${value.image.mime};base64,`),
  { message: "Stored image content must be an inline image matching its declared MIME type." },
);
export type HistoryImageReference = z.infer<typeof historyImageReference>;
export type HistoryImageMetadata = z.infer<typeof historyImageMetadata>;
export type HistoryImagePage = z.infer<typeof historyImagePage>;
export type HistoryImagePayload = z.infer<typeof historyImagePayload>;
