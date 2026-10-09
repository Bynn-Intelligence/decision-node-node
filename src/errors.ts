import { parseBoostersHeader, type BoosterStatus } from './boosters.js';
import { parseSafety, type Safety } from './safety.js';

export interface ErrorFields {
  status?: number | null;
  errorType?: string | null;
  requestId?: string | null;
  reason?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * The base of every error this SDK throws, and the class of any status that
 * has no class of its own (a 3xx, 405, 409, or 408 once its retries are spent).
 *
 * `message` is the server's own message exactly as sent: `detail.message`, or
 * `detail` when it is a string, and empty when the response carried none. When
 * no response arrived, it describes what went wrong on the client side. The
 * server's explanation in words is in `reason`.
 */
export class DecisionNodeError extends Error {
  /** The HTTP status, or `null` when no response arrived. */
  readonly status: number | null;
  /** `detail.error_type` from the error body, or `null`. */
  readonly errorType: string | null;
  /** The `x-request-id` response header. */
  readonly requestId: string | null;
  /** The server's explanation in words, from the `x-decisionnode-error` header, as received. */
  readonly reason: string | null;
  /** The parsed error body, or the raw text when it was not JSON. */
  readonly body: unknown;
  /** The response headers, names lower-cased. */
  readonly headers: Record<string, string>;
  /**
   * For a request that named boosters: each booster's status and time, by name
   * in the request's order, from the `x-decisionnode-boosters` header, so you
   * can see which required booster failed. Empty when the header is absent.
   */
  readonly boosters: Record<string, BoosterStatus>;

  constructor(message: string, fields: ErrorFields = {}) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.status = fields.status ?? null;
    this.errorType = fields.errorType ?? null;
    this.requestId = fields.requestId ?? null;
    this.reason = fields.reason ?? null;
    this.body = fields.body;
    this.headers = fields.headers ?? {};
    this.boosters = parseBoostersHeader(this.headers['x-decisionnode-boosters']);
  }
}

/** 400. */
export class BadRequestError extends DecisionNodeError {}

/** 400 with `error_type` `max_tokens_exceeded`: the request is over the model's token limit. */
export class ContextLimitError extends BadRequestError {}

/** 401, or no API key configured. */
export class AuthenticationError extends DecisionNodeError {}

/** 402: the account has no credit left. */
export class InsufficientCreditError extends DecisionNodeError {}

/**
 * 403 that is not a refusal: the workspace may not do this, for example use a
 * booster that is turned off for it (`booster_not_enabled`), or the workspace
 * is suspended. `errorType` tells them apart.
 */
export class PermissionDeniedError extends DecisionNodeError {}

/** 403 `refusal_error`: the request was refused under the usage policy. Never retried. */
export class RefusalError extends DecisionNodeError {
  /** `harm` or `self_harm`. */
  readonly category: string | null;
  /** What the safety check found. */
  readonly safety: Safety | null;

  constructor(message: string, fields: ErrorFields & { category?: string | null; safety?: Safety | null } = {}) {
    super(message, fields);
    this.category = fields.category ?? null;
    this.safety = fields.safety ?? null;
  }
}

/** 404. */
export class NotFoundError extends DecisionNodeError {}

/**
 * 413, or a body found over the API's limit of 26,214,400 bytes (25 MiB)
 * before it was sent (then with no status and no request id). Never retried:
 * the same body is refused again. Send large images as uploads.
 */
export class RequestTooLargeError extends DecisionNodeError {}

/** 422: the request body did not validate. */
export class ValidationError extends DecisionNodeError {
  /** The server's list of validation entries. */
  readonly entries: unknown[] | null;

  constructor(message: string, fields: ErrorFields & { entries?: unknown[] | null } = {}) {
    super(message, fields);
    this.entries = fields.entries ?? null;
  }
}

/** 429. */
export class RateLimitError extends DecisionNodeError {
  /** Seconds the server asked to wait (at most 60), or `null`. */
  readonly retryAfter: number | null;

  constructor(message: string, fields: ErrorFields & { retryAfter?: number | null } = {}) {
    super(message, fields);
    this.retryAfter = fields.retryAfter ?? null;
  }
}

/**
 * 429 `session_limit_exceeded`: the key holds as many open sessions as it may.
 * Never retried, since the count frees when a session ends, not when time passes.
 */
export class SessionLimitError extends RateLimitError {}

/**
 * 529: the service is overloaded, or a booster the request required failed or
 * did not answer in time (`errorType` `booster_unavailable`). Retried like
 * every 529.
 */
export class OverloadedError extends DecisionNodeError {
  /** Seconds the server asked to wait (at most 60), or `null`. */
  readonly retryAfter: number | null;

  constructor(message: string, fields: ErrorFields & { retryAfter?: number | null } = {}) {
    super(message, fields);
    this.retryAfter = fields.retryAfter ?? null;
  }
}

/** Any other 5xx, or a success response whose body is not JSON. */
export class ServerError extends DecisionNodeError {}

/** No response: the connection failed or was dropped. */
export class ConnectionError extends DecisionNodeError {}

/** No response within the timeout. */
export class TimeoutError extends DecisionNodeError {}

// Class names survive minification: `error.name` is always the class's public name.
for (const [name, cls] of Object.entries({
  DecisionNodeError,
  BadRequestError,
  ContextLimitError,
  AuthenticationError,
  InsufficientCreditError,
  PermissionDeniedError,
  RefusalError,
  NotFoundError,
  RequestTooLargeError,
  ValidationError,
  RateLimitError,
  SessionLimitError,
  OverloadedError,
  ServerError,
  ConnectionError,
  TimeoutError,
})) {
  Object.defineProperty(cls.prototype, 'name', { value: name, writable: true, configurable: true });
}

/** The longest wait a server can ask for, in seconds. Longer requests are cut to this. */
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Seconds to wait from `retry-after-ms`, else `Retry-After` (seconds or an
 * HTTP date), else `null`. Capped at 60 seconds.
 */
export function retryAfterSeconds(headers: Record<string, string>): number | null {
  const cap = (n: number) => Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, n));
  const ms = headers['retry-after-ms'];
  if (ms !== undefined) {
    const n = Number(ms);
    if (ms.trim() !== '' && Number.isFinite(n)) return cap(n / 1000);
  }
  const s = headers['retry-after'];
  if (s !== undefined) {
    const n = Number(s);
    if (s.trim() !== '' && Number.isFinite(n)) return cap(n);
    const date = Date.parse(s);
    if (!Number.isNaN(date)) return cap((date - Date.now()) / 1000);
  }
  return null;
}

/** Builds the error for a response outside 200 to 299. */
export function errorFromResponse(status: number, headers: Record<string, string>, text: string): DecisionNodeError {
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON (a proxy's HTML page, for example): keep the text.
  }
  const detail = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { detail?: unknown }).detail : undefined;

  let errorType: string | null = null;
  let message = '';
  let entries: unknown[] | null = null;
  let category: string | null = null;
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    if (typeof d.error_type === 'string') errorType = d.error_type;
    if (typeof d.message === 'string') message = d.message;
    if (typeof d.category === 'string') category = d.category;
  } else if (typeof detail === 'string') {
    message = detail;
  } else if (Array.isArray(detail)) {
    entries = detail;
  }

  const requestId = headers['x-request-id'] ?? null;
  const reason = headers['x-decisionnode-error'] ?? null;
  const fields: ErrorFields = { status, errorType, requestId, reason, body, headers };

  if (status === 400) {
    return errorType === 'max_tokens_exceeded' ? new ContextLimitError(message, fields) : new BadRequestError(message, fields);
  }
  if (status === 401) return new AuthenticationError(message, fields);
  if (status === 402) return new InsufficientCreditError(message, fields);
  if (status === 403) {
    if (errorType === 'refusal_error') {
      return new RefusalError(message, { ...fields, category, safety: parseSafety(headers['x-decisionnode-safety']) });
    }
    return new PermissionDeniedError(message, fields);
  }
  if (status === 404) return new NotFoundError(message, fields);
  if (status === 413) return new RequestTooLargeError(message, fields);
  if (status === 422) return new ValidationError(message, { ...fields, entries });
  if (status === 429 && errorType === 'session_limit_exceeded') {
    return new SessionLimitError(message, { ...fields, retryAfter: retryAfterSeconds(headers) });
  }
  if (status === 429) return new RateLimitError(message, { ...fields, retryAfter: retryAfterSeconds(headers) });
  if (status === 529) return new OverloadedError(message, { ...fields, retryAfter: retryAfterSeconds(headers) });
  if (status >= 500 && status <= 599) return new ServerError(message, fields);
  return new DecisionNodeError(message, fields);
}

/**
 * A fault in the request's content found before anything was sent: the API's
 * own class and `error_type`, with no status and no request id.
 */
export function localError<E extends DecisionNodeError>(
  cls: new (message: string, fields?: ErrorFields) => E,
  message: string,
  errorType: string | null = 'api_usage_error',
): E {
  return new cls(message, { errorType });
}
