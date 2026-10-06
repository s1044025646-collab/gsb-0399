export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_HEX'
  | 'INVALID_BASE64'
  | 'INVALID_ENCODING'
  | 'LENGTH_MISMATCH'
  | 'INVALID_PRIMARY'
  | 'BLOCK_TOO_LARGE'
  | 'OUTPUT_BUDGET_EXCEEDED'
  | 'NOT_FOUND'
  | 'INVALID_JSON'
  | 'INVALID_PAGINATION'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'FILE_READ_ERROR'
  | 'FILE_WRITE_ERROR'
  | 'INVALID_EXPORT'
  | 'DIGEST_MISMATCH'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
