import { z } from "zod";

// ADR-003 §4 : { code, params, requestId }. `code` stable, jamais de texte localise.
export const ErrorCode = z.enum([
  "INTERNAL_ERROR",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "SCHEDULE_RANGE_INVALID",
  "SCHEDULE_CURSOR_INVALID",
  "FORBIDDEN",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "PRECONDITION_REQUIRED",
  "TIMEOFF_OVERLAP",
  "ALREADY_EXISTS",
  "REFERENCE_IN_USE",
  "TEAM_REMOVAL_CONFIRMATION_REQUIRED",
  "TEAM_REMOVAL_STALE_CONFIRMATION",
  "TEAM_REMOVAL_LOCKED_LOGS",
  "RATE_LIMITED",
]).meta({ id: "ErrorCode" });

export const ApiError = z
  .object({
    code: ErrorCode,
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    requestId: z.string(),
  })
  .meta({ id: "ApiError" });
export type ApiError = z.infer<typeof ApiError>;
