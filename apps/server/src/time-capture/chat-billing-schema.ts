import { z } from "zod";
import { TimesheetCommandSchema, type TimesheetCommand } from "../back-office/timesheet-schema.js";

export function isTimekeepingBillingCommand(command: TimesheetCommand) {
  switch (command.type) {
    case "create":
      return command.source !== "suggestion" && !command.proposalDigest;
    case "submit":
    case "review":
    case "approve":
    case "return":
    case "applyWording":
    case "assignBillingClient":
    case "createInvoice":
    case "prepareInvoice":
    case "reviewInvoiceWording":
    case "approveInvoice":
    case "issueInvoice":
    case "policy":
      return true;
    default:
      return false;
  }
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
    command: TimesheetCommandSchema.refine(isTimekeepingBillingCommand, "Use the permitted timekeeping operations."),
  }),
]);
