import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'FIELD_CONFLICT',
  'BLOBS_MISSING',
  'EXPORT_NOT_READY',
  'GONE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'VALIDATION_ERROR',
  'HASH_MISMATCH',
  'RAW_IMMUTABLE',
  'SIZE_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  FIELD_CONFLICT: 409,
  BLOBS_MISSING: 409,
  EXPORT_NOT_READY: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  VALIDATION_ERROR: 422,
  HASH_MISMATCH: 422,
  RAW_IMMUTABLE: 422,
  SIZE_MISMATCH: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Error thrown by any layer; the server maps it to {@link ErrorBody}. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}
