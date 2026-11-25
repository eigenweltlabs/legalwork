import { setTimeout as delay } from "node:timers/promises";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import { requireBackOfficePrincipal } from "./accounts.js";
import type { backOfficeAccess } from "./access.js";
import { TimesheetStateSchema } from "./timesheet-schema.js";

type Access = Awaited<ReturnType<typeof backOfficeAccess>>;

export async function requestPlatformTimesheet(
  config: ServerConfig,
  access: Access,
  method: string,
  path: string,
  body?: unknown,
) {
  const principal = access.actor.principalKey;
  if (!principal)
    throw new ApiError(
      403,
      "timesheet",
      "Sign in to the firm to use shared timesheets.",
    );
  await ensureFreshPlatformToken(config);
  const request = async () => {
    const client = requireIntakeClient(await requireBackOfficePrincipal(config, principal));
    return intakeRequest(client, method, "/api/back-office/timesheet" + path, body);
  };
  try {
    const value = await request().catch(async (error: unknown) => {
      // Keep the existing write recovery path. A failed response may follow a committed write.
      const upstreamStatus = error instanceof ApiError && error.code === "back_office_sync_failed"
        ? error.details : undefined;
      if (method !== "GET" || path || typeof upstreamStatus !== "number" || ![500, 502, 503, 504].includes(upstreamStatus))
        throw error;
      await delay(250);
      return request();
    });
    await requireBackOfficePrincipal(config, principal);
    return value;
  } catch (error) {
    if (error instanceof ApiError && [404, 501].includes(error.status))
      throw new ApiError(
        501,
        "timesheet_service_unavailable",
        "The connected firm supports Back Office records, but not the timesheet approval service.",
      );
    throw error;
  }
}

export async function readPlatformTimesheet(
  config: ServerConfig,
  access: Access,
  method = "GET",
  body?: unknown,
) {
  const origin = method === "POST" && access.actor.agentId === "timekeeping" ? "?origin=timekeeping" : "";
  const result = TimesheetStateSchema.safeParse(
    await requestPlatformTimesheet(config, access, method, origin, body),
  );
  if (
    !result.success ||
    result.data.userId !== access.actor.userId ||
    result.data.scope !== access.scope
  )
    throw new ApiError(
      502,
      "timesheet",
      "The connected firm server did not return this account’s timesheet.",
    );
  return result.data;
}
