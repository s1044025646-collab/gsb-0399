import { readFile, writeFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { decodeTextInput, type ByteInputFormat, type ByteInput } from './core/bytes.js';
import {
  bwt,
  buildRotationRows,
  DEFAULT_MAX_BLOCK_BYTES,
  inverseBwt,
  lfStep,
  type RotationRow,
} from './core/bwt.js';
import { sha256 } from './core/digest.js';
import { makeExport, parseExport, verifyOriginalDigest } from './core/export.js';
import { AppError } from './errors.js';
import { getBlockRequired, insertBlock, type StoredBlock } from './db.js';

export interface ServiceOptions {
  defaultMaxBlockBytes?: number;
}

export interface Page {
  limit: number;
  offset: number;
}

export function parsePositiveInteger(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numberValue = typeof value === 'string' ? Number(value) : value;
  if (typeof numberValue !== 'number' || !Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new AppError('INVALID_PAGINATION', `${name} 必须是非负安全整数。`);
  }
  if (numberValue > maximum) throw new AppError('INVALID_PAGINATION', `${name} 不能超过 ${maximum}。`);
  return numberValue;
}

export class BwtService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly options: ServiceOptions = {},
  ) {}

  get defaultMaxBlockBytes(): number {
    return this.options.defaultMaxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
  }

  readLimit(value: unknown): number {
    return parsePositiveInteger(value, 'maxBlockBytes', this.defaultMaxBlockBytes, this.defaultMaxBlockBytes);
  }

  async readInputFile(path: string, maxBlockBytes: number): Promise<ByteInput> {
    try {
      const bytes = await readFile(path);
      if (bytes.length > maxBlockBytes) {
        throw new AppError('BLOCK_TOO_LARGE', `文件块长度 ${bytes.length} 超过上限 ${maxBlockBytes} 字节。`, 413);
      }
      return { bytes, format: 'file', sourceName: path };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('FILE_READ_ERROR', `无法读取文件：${path}`, 400);
    }
  }

  readTextInput(format: 'utf8' | 'hex' | 'base64', value: unknown, maxBlockBytes: number): ByteInput {
    if (typeof value !== 'string') throw new AppError('INVALID_INPUT', '输入值必须是字符串。');
    const bytes = decodeTextInput(format, value);
    if (bytes.length > maxBlockBytes) {
      throw new AppError('BLOCK_TOO_LARGE', `块长度 ${bytes.length} 超过上限 ${maxBlockBytes} 字节。`, 413);
    }
    return { bytes, format };
  }

  transform(input: ByteInput, maxBlockBytes = this.defaultMaxBlockBytes) {
    const result = bwt(input.bytes, maxBlockBytes);
    const stored = insertBlock(this.database, {
      inputBytes: input.bytes,
      inputFormat: input.format,
      L: result.L,
      primary: result.primary,
      maxBlockBytes,
    });
    return {
      ...result,
      id: stored.id,
      inputSha256: sha256(input.bytes),
      LSha256: sha256(result.L),
      sourceName: input.sourceName ?? null,
    };
  }

  getStored(id: string): StoredBlock {
    return getBlockRequired(this.database, id);
  }

  getRotations(stored: StoredBlock, page: Page): { rows: RotationRow[]; total: number } {
    const reconstructed = inverseBwt(stored.lBytes, stored.primary, { outputBudget: stored.maxBlockBytes });
    if (stored.inputSha256 !== sha256(reconstructed)) {
      throw new AppError('DIGEST_MISMATCH', '数据库产物无法重建成原摘要对应字节。', 409);
    }
    const rows = buildRotationRows(reconstructed, stored.maxBlockBytes);
    return {
      total: rows.length,
      rows: rows.slice(page.offset, page.offset + page.limit),
    };
  }

  getLfStep(stored: StoredBlock, row: number) {
    if (!Number.isSafeInteger(row) || row < 0 || row >= stored.length) {
      throw new AppError('INVALID_PRIMARY', 'LF 查询行号越界。', 400, { row, rowCount: stored.length });
    }
    return lfStep(stored.lBytes, row);
  }

  inverseStored(stored: StoredBlock, outputBudget: number) {
    const bytes = inverseBwt(stored.lBytes, stored.primary, { outputBudget });
    return {
      bytes,
      digestMatches: stored.inputSha256 === sha256(bytes),
      expectedSha256: stored.inputSha256,
      actualSha256: sha256(bytes),
    };
  }

  exportStored(stored: StoredBlock, includeDigest = true) {
    return includeDigest
      ? makeExport(stored.lBytes, stored.primary, { originalSha256: stored.inputSha256 })
      : makeExport(stored.lBytes, stored.primary);
  }

  async importExportFile(path: string, maxBlockBytes: number) {
    let json: string;
    try {
      json = await readFile(path, 'utf8');
    } catch {
      throw new AppError('FILE_READ_ERROR', `无法读取导出文件：${path}`);
    }
    return this.importExportJson(json, maxBlockBytes, path);
  }

  importExportJson(json: string, maxBlockBytes: number, sourceName?: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new AppError('INVALID_JSON', '导出文件不是合法 JSON。');
    }
    const parsedExport = parseExport(parsed, maxBlockBytes);
    const bytes = inverseBwt(parsedExport.L, parsedExport.primary, { outputBudget: maxBlockBytes });
    const digestMatches = verifyOriginalDigest(bytes, parsedExport.originalSha256);
    const stored = insertBlock(this.database, {
      inputBytes: bytes,
      inputFormat: 'export',
      ...(sourceName === undefined ? {} : { sourceName }),
      L: parsedExport.L,
      primary: parsedExport.primary,
      maxBlockBytes,
    });
    return {
      id: stored.id,
      length: parsedExport.L.length,
      primary: parsedExport.primary,
      digestMatches,
      expectedSha256: parsedExport.originalSha256 ?? null,
      actualSha256: sha256(bytes),
    };
  }

  async writeInverseOutput(stored: StoredBlock, outputPath: string, outputBudget: number, force: boolean) {
    const result = this.inverseStored(stored, outputBudget);
    try {
      await writeFile(outputPath, result.bytes, { flag: force ? 'w' : 'wx' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new AppError('FILE_WRITE_ERROR', `输出文件已存在：${outputPath}`);
      throw new AppError('FILE_WRITE_ERROR', `无法写入文件：${outputPath}`);
    }
    return { outputPath, ...result };
  }
}
