/** Base class for every error raised by this SDK. */
export class IdemcoreError extends Error {
  readonly type: string;
  readonly status: number | null;
  readonly headers: Record<string, string>;
  constructor(message: string, opts: { type?: string; status?: number | null; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = new.target.name;
    this.type = opts.type ?? "error";
    this.status = opts.status ?? null;
    this.headers = opts.headers ?? {};
  }
}
export class APIConnectionError extends IdemcoreError {}
export class InvalidRequestError extends IdemcoreError {}
export class AuthenticationError extends IdemcoreError {}
export class PermissionDeniedError extends IdemcoreError {}
export class NotFoundError extends IdemcoreError {}
export class ConflictError extends IdemcoreError {}
export class RateLimitError extends IdemcoreError {
  /** Seconds to wait, from the Retry-After header, when present. */
  get retryAfter(): number | null {
    const v = Number(this.headers["retry-after"]);
    return Number.isFinite(v) && this.headers["retry-after"] !== undefined ? v : null;
  }
}
export class InsufficientQuotaError extends IdemcoreError {}
export class ServiceUnavailableError extends IdemcoreError {}
export class InternalServerError extends IdemcoreError {}

const BY_TYPE: Record<string, typeof IdemcoreError> = {
  invalid_request_error: InvalidRequestError,
  authentication_error: AuthenticationError,
  permission_error: PermissionDeniedError,
  not_found_error: NotFoundError,
  rate_limit_error: RateLimitError,
  insufficient_quota: InsufficientQuotaError,
  service_unavailable: ServiceUnavailableError,
  server_error: InternalServerError,
};

export function errorFrom(status: number | null, body: unknown, headers: Record<string, string> = {}): IdemcoreError {
  const e = (body && typeof body === "object" ? (body as { error?: { type?: string; message?: string } }).error : undefined) ?? {};
  const type = typeof e.type === "string" ? e.type : "";
  const message = typeof e.message === "string" ? e.message : `HTTP ${status ?? "error"}`;
  let C = BY_TYPE[type];
  if (!C) {
    C = status === 400 || status === 415 || status === 413 ? InvalidRequestError
      : status === 401 ? AuthenticationError
      : status === 403 ? PermissionDeniedError
      : status === 404 ? NotFoundError
      : status === 409 ? ConflictError
      : status === 429 ? RateLimitError
      : status === 503 ? ServiceUnavailableError
      : InternalServerError;
  }
  return new C(message, { type: type || "error", status, headers });
}
