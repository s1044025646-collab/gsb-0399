/**
 * 统一错误结构：携带稳定的机器可读错误码，便于 API 与 CLI 一致处理。
 */
export type ErrorCode =
  | "BLOCK_TOO_LARGE"
  | "EMPTY_BLOCK"
  | "INVALID_HEX"
  | "INVALID_BASE64"
  | "LENGTH_MISMATCH"
  | "PRIMARY_OUT_OF_RANGE"
  | "OUTPUT_BUDGET_EXCEEDED"
  | "UNSUPPORTED_ENCODING"
  | "RECORD_NOT_FOUND"
  | "BAD_REQUEST"
  | "DIGEST_MISMATCH"
  | "PAGE_OUT_OF_RANGE"
  | "FILE_READ_FAILED"
  | "FILE_WRITE_FAILED";

export class BwtError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BwtError";
    this.code = code;
    this.details = details;
  }
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BLOCK_TOO_LARGE: 413,
  EMPTY_BLOCK: 400,
  INVALID_HEX: 400,
  INVALID_BASE64: 400,
  LENGTH_MISMATCH: 400,
  PRIMARY_OUT_OF_RANGE: 400,
  OUTPUT_BUDGET_EXCEEDED: 413,
  UNSUPPORTED_ENCODING: 400,
  RECORD_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  DIGEST_MISMATCH: 409,
  PAGE_OUT_OF_RANGE: 400,
  FILE_READ_FAILED: 400,
  FILE_WRITE_FAILED: 500,
};
