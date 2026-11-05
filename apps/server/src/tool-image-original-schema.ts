import { z } from "zod";

const integer = z.number().int().nonnegative().safe();
export const toolImageOriginalReference = z.object({ id: z.uuid(), sessionID: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const toolImageCaptureInput = z.object({ messageID: z.string().min(1), callID: z.string().min(1), tool: z.string().min(1),
  contentIndex: integer, mime: z.string().regex(/^image\/[a-z0-9.+-]+$/i), name: z.string().optional() }).strict();
export const toolImageOriginal = z.object({ reference: toolImageOriginalReference, bytes: integer, mime: z.string(), name: z.string().optional(),
  header: z.discriminatedUnion("status", [z.object({ status: z.literal("unavailable") }), z.object({ status: z.literal("available"),
    encodedWidth: integer.positive(), encodedHeight: integer.positive(), type: z.string(), orientation: integer.nullable(), orientationSource: z.enum(["jpeg-exif", "not-exposed"]),
    cropCoordinates: z.discriminatedUnion("status", [z.object({ status: z.literal("unsupported-format") }), z.object({ status: z.literal("header-derived-expectation"),
      coordinateSpace: z.literal("decoded-raster-pixels"), expectedWidth: integer.positive(), expectedHeight: integer.positive(),
      orientationPolicy: z.enum(["jpeg-exif-applied", "png-webp-metadata-unhandled"]), decoder: z.literal("@napi-rs/canvas"),
      qualification: z.literal("The crop worker validates actual decoded dimensions and format before processing.") })]) })]),
  source: z.object({ messageID: z.string(), outerCallID: z.string(), tool: z.string(), contentIndex: integer, captureOrdinal: integer,
    linkage: z.enum(["direct-native-call", "observed-child-of-native-call"]), storageNamespace: z.string().default("unverified"), capturedDirectory: z.string(), capturedProjectID: z.string(), capturedWorkspaceID: z.string(), capturedAt: integer }),
  provenance: z.literal("pre-normalization-tool-original") });
export const toolImageOriginalListInput = z.object({ sessionID: z.string().min(1).optional(), cursor: z.string().min(1).optional() }).strict();
export const toolImageOriginalPage = z.object({ sessionID: z.string(), images: z.array(toolImageOriginal),
  nextCursor: z.string().nullable(), pageSize: z.literal(100), parent: z.discriminatedUnion("status", [
    z.object({ status: z.literal("none") }), z.object({ status: z.literal("available"), sessionID: z.string() }), z.object({ status: z.literal("unavailable") }),
  ]) });
export const toolImageCropRectangle = z.object({ x: integer, y: integer, width: integer.positive(), height: integer.positive() }).strict();
export const toolImageCropInput = z.object({ reference: toolImageOriginalReference, rectangle: toolImageCropRectangle }).strict();
export const toolImageExportInput = z.object({ reference: toolImageOriginalReference, path: z.string().min(1), overwrite: z.boolean().default(false) }).strict();
export type ToolImageOriginal = z.infer<typeof toolImageOriginal>;
export type ToolImageOriginalReference = z.infer<typeof toolImageOriginalReference>;
export type ToolImageCaptureInput = z.infer<typeof toolImageCaptureInput>;

/** Namespaced references are claims until the actual public native call commits. */
export const toolImageLinkedMetadata = z.object({ status: z.literal("retained-pending-native-commit"), originals: z.array(toolImageOriginal) });
export const TOOL_IMAGE_METADATA_KEY = "legalworkOriginalImages";
export const toolImageOriginalPayload = z.object({ image: toolImageOriginal, uri: z.string() });
export const toolImageCropMetadata = z.object({ mime: z.literal("image/png"), originalSha256: z.string(),
  source: z.object({ mime: z.enum(["image/png", "image/jpeg", "image/webp"]), encodedWidth: integer.positive(), encodedHeight: integer.positive(),
    decodedWidth: integer.positive(), decodedHeight: integer.positive(), orientation: integer.nullable(), orientationSource: z.enum(["jpeg-exif", "not-exposed"]),
    orientationPolicy: z.enum(["jpeg-exif-applied", "png-webp-metadata-unhandled"]), coordinateSpace: z.literal("decoded-raster-pixels"),
    decoder: z.object({ name: z.literal("@napi-rs/canvas"), version: z.string() }) }),
  rectangle: toolImageCropRectangle, output: z.object({ width: integer.positive(), height: integer.positive(), sha256: z.string(), encoding: z.literal("png") }) });
export const toolImageCropPayload = z.object({ image: toolImageOriginal, crop: toolImageCropMetadata, uri: z.string() });
export const toolImageExportOutput = z.object({ image: toolImageOriginal, path: z.string(), bytes: integer, sha256: z.string() });
