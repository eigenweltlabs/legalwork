import { z } from "zod";

/** Exact native approval metadata; internal chats and credentials stay private. */
export const LegalMemoryPermissionSchema = z.object({ operationID: z.string(), requestID: z.string(), action: z.string(), resources: z.array(z.string()), message: z.string().optional() });
export const LegalMemoryPermissionsSchema = z.object({ workspace: z.object({ id: z.string(), name: z.string() }), requests: z.array(LegalMemoryPermissionSchema) });
export const LegalMemoryPermissionReplySchema = z.object({ operationID: z.string(), requestID: z.string(), decision: z.enum(["once", "reject"]) }).strict();
export type LegalMemoryPermission = z.infer<typeof LegalMemoryPermissionSchema>;
export type LegalMemoryPermissions = z.infer<typeof LegalMemoryPermissionsSchema>;
export type LegalMemoryPermissionReply = z.infer<typeof LegalMemoryPermissionReplySchema>;
