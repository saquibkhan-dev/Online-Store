/** Error that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (details?: unknown) => new AppError(400, "VALIDATION_ERROR", "Request validation failed", details),
  badRequest: (code: string, message: string) => new AppError(400, code, message),
  unauthorized: (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "You do not have access to this resource") => new AppError(403, "FORBIDDEN", message),
  notFound: (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  unavailable: (message = "Dependency unavailable") => new AppError(503, "SERVICE_UNAVAILABLE", message)
};

/** An event/message that can never succeed; it goes to the dead-letter topic instead of being retried. */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
