import {z} from 'zod';
const count=z.number().int().nonnegative();
export const mailMaintenanceReportSchema=z.object({accounts:count,messages:count,references:count,bytes:count,retainedRecords:count,retainedParts:count,incompleteParts:count,schemaVersion:count}).strict();
export type MailMaintenanceReport=z.infer<typeof mailMaintenanceReportSchema>;
export const mailMaintenanceResponseSchema=z.object({completed:z.literal(true),state:z.literal('locked'),report:mailMaintenanceReportSchema.nullable()}).strict();
