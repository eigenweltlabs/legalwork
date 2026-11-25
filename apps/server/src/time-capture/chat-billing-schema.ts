import { z } from "zod";
import { TimesheetCommandSchema, type TimesheetCommand } from "../back-office/timesheet-schema.js";

const billingTypes = new Set<TimesheetCommand["type"]>([
  "create", "submit", "review", "approve", "return", "applyWording", "assignBillingClient", "createInvoice", "policy",
]);
const [firstCommand, ...otherCommands] = TimesheetCommandSchema.options.filter(schema =>
  [...billingTypes].some(type => schema.shape.type.safeParse(type).success),
);
if (!firstCommand) throw new Error("Timekeeping billing commands are unavailable.");

export function isTimekeepingBillingCommand(command: TimesheetCommand) {
  if (command.type === "create") return command.source !== "suggestion" && !command.proposalDigest;
  return billingTypes.has(command.type);
}

export const chatBillingAction = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("read"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    matterId: z.string().optional(),
    invoiceNumber: z.number().int().positive().safe().optional(),
  }),
  z.strictObject({
    action: z.literal("apply"),
    command: z.discriminatedUnion("type", [firstCommand, ...otherCommands])
      .refine(isTimekeepingBillingCommand, "Use the permitted timekeeping operations."),
  }),
]);
