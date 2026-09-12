import {z} from 'zod';
const count=z.number().int().nonnegative();
export const qualificationInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('start'),accountId:z.string().min(1).max(4096),maxMessages:z.number().int().min(1).max(10000).default(2000),samples:z.number().int().min(1).max(20).default(10)}).strict(),
 z.object({action:z.enum(['read','cancel']),id:z.string().uuid()}).strict(),
]);
export const qualificationReportSchema=z.object({id:z.string().uuid(),provider:z.literal('gmail'),startedAt:count,finishedAt:count.nullable(),state:z.enum(['running','complete','inconclusive','limited','cancelled','failed']),comparison:z.enum(['pending','match','mismatch','inconclusive']),phase:z.enum(['enumeration','memberships','samples','finished']),
 maxMessages:count,sampleLimit:count,scope:z.literal('all_messages_including_spam_trash'),providerMessages:count,localMessages:count,missingLocal:count,extraLocal:count,duplicateProviderIds:count,providerLabels:count,localLabels:count,missingLabels:count,extraLabels:count,membershipsChecked:count,membershipMismatches:count,
 rawSamples:count,rawMismatches:count,attachmentSamples:count,attachmentMismatches:count,bodySamples:count,bodyMismatches:count,incompleteSamples:count,skippedOversizeSamples:count,downloadedSampleBytes:count,providerStable:z.boolean().nullable(),localStable:z.boolean().nullable(),error:z.enum(['unavailable','provider_failed','limit','changed','cancelled']).nullable()}).strict();
export type QualificationInput=z.infer<typeof qualificationInputSchema>;
export type QualificationReport=z.infer<typeof qualificationReportSchema>;
