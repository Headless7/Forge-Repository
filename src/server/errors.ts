export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL";

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

/** An error whose message is safe to show to end users. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = () => new AppError("UNAUTHORIZED", "Your session has expired. Please sign in again.");

export const forbidden = (message = "You don't have permission to do that.") => new AppError("FORBIDDEN", message);

/** Used for both missing records and records the caller may not see, so IDs can't be probed. */
export const notFound = (what = "That item") =>
  new AppError("NOT_FOUND", `${what} was not found, or you no longer have access to it.`);

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError("CONFLICT", message, details);

export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError("VALIDATION", message, details);

export const rateLimited = (retryAfterMs: number) =>
  new AppError("RATE_LIMITED", "You're doing that too often. Please wait a moment and try again.", {
    retryAfterMs,
  });

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint_name?: string; cause?: unknown };
  if (e?.code === "23505") return constraint ? e.constraint_name === constraint : true;
  if (e?.cause) return isUniqueViolation(e.cause, constraint);
  return false;
}
