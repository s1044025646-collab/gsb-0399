import { AppError } from '../errors.js';
import { decodeBase64, decodeHex, encodeBase64 } from './bytes.js';
import { TRANSFORM_VERSION, validateBlockLength, validateTransformPayload } from './bwt.js';
import { sha256 } from './digest.js';

export const EXPORT_FORMAT = 'byte-bwt-export';
export const EXPORT_VERSION = 1;

export type LCoding = 'base64' | 'hex';

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  exportVersion: typeof EXPORT_VERSION;
  transformVersion: typeof TRANSFORM_VERSION;
  block: {
    length: number;
    primary: number;
    LCoding: LCoding;
    L: string;
  };
  summary?: {
    originalSha256?: string;
    LSha256?: string;
  };
  createdAt: string;
}

export function makeExport(
  L: Uint8Array,
  primary: number,
  options: { originalSha256?: string; createdAt?: Date } = {},
): ExportDocument {
  validateTransformPayload(L, primary);
  const document: ExportDocument = {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    transformVersion: TRANSFORM_VERSION,
    block: {
      length: L.length,
      primary,
      LCoding: 'base64',
      L: encodeBase64(L),
    },
    createdAt: (options.createdAt ?? new Date()).toISOString(),
  };
  if (options.originalSha256 !== undefined) {
    document.summary = { originalSha256: options.originalSha256, LSha256: sha256(L) };
  }
  return document;
}

export function parseExport(document: unknown, maxBlockBytes: number): {
  L: Uint8Array;
  primary: number;
  originalSha256?: string;
  LSha256?: string;
} {
  if (typeof document !== 'object' || document === null) {
    throw new AppError('INVALID_EXPORT', '导出文件必须是 JSON 对象。');
  }
  const value = document as Record<string, unknown>;
  if (value.format !== EXPORT_FORMAT) {
    throw new AppError('INVALID_EXPORT', `format 必须是 ${EXPORT_FORMAT}。`);
  }
  if (value.exportVersion !== EXPORT_VERSION) {
    throw new AppError('INVALID_EXPORT', `暂不支持 exportVersion=${String(value.exportVersion)}。`);
  }
  if (value.transformVersion !== TRANSFORM_VERSION) {
    throw new AppError('INVALID_EXPORT', `transformVersion 必须是 ${TRANSFORM_VERSION}。`);
  }
  const block = value.block as Record<string, unknown> | undefined;
  if (!block || typeof block !== 'object') {
    throw new AppError('INVALID_EXPORT', '缺少 block 对象。');
  }
  const length = block.length;
  const primary = block.primary;
  const LCoding = block.LCoding;
  const encodedL = block.L;

  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new AppError('LENGTH_MISMATCH', 'block.length 必须是非负安全整数。');
  }
  validateBlockLength(length, maxBlockBytes);
  if (typeof primary !== 'number' || !Number.isSafeInteger(primary)) {
    throw new AppError('INVALID_PRIMARY', 'primary 必须是安全整数。');
  }
  if (typeof encodedL !== 'string' || typeof LCoding !== 'string') {
    throw new AppError('INVALID_EXPORT', 'L 与 LCoding 必须是字符串。');
  }

  let L: Uint8Array;
  if (LCoding === 'base64') L = decodeBase64(encodedL);
  else if (LCoding === 'hex') L = decodeHex(encodedL);
  else throw new AppError('INVALID_ENCODING', 'LCoding 只支持 base64 或 hex。');

  if (L.length !== length) {
    throw new AppError('LENGTH_MISMATCH', 'L 解码长度与 block.length 不一致。', 400, {
      declared: length,
      actual: L.length,
    });
  }
  validateTransformPayload(L, primary);

  let originalSha256: string | undefined;
  let LSha256: string | undefined;
  if (value.summary !== undefined) {
    if (typeof value.summary !== 'object' || value.summary === null) {
      throw new AppError('INVALID_EXPORT', 'summary 必须是对象。');
    }
    const summary = value.summary as Record<string, unknown>;
    if (summary.originalSha256 !== undefined) {
      if (typeof summary.originalSha256 !== 'string') {
        throw new AppError('INVALID_EXPORT', 'originalSha256 必须是字符串。');
      }
      originalSha256 = summary.originalSha256;
    }
    if (summary.LSha256 !== undefined) {
      if (typeof summary.LSha256 !== 'string') {
        throw new AppError('INVALID_EXPORT', 'LSha256 必须是字符串。');
      }
      LSha256 = summary.LSha256;
      if (sha256(L) !== LSha256) throw new AppError('DIGEST_MISMATCH', 'L 的 SHA-256 摘要不匹配。', 409);
    }
  }
  const parsedResult: { L: Uint8Array; primary: number; originalSha256?: string; LSha256?: string } = { L, primary };
  if (originalSha256 !== undefined) parsedResult.originalSha256 = originalSha256;
  if (LSha256 !== undefined) parsedResult.LSha256 = LSha256;
  return parsedResult;
}

export function verifyOriginalDigest(bytes: Uint8Array, expectedSha256: string | undefined): boolean {
  return expectedSha256 === undefined || sha256(bytes) === expectedSha256;
}
