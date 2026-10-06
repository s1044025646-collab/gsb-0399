import { AppError } from '../errors.js';

export const DEFAULT_MAX_BLOCK_BYTES = 4096;
export const TRANSFORM_VERSION = 'BWT-BYTE/1';

export interface BwtResult {
  length: number;
  primary: number;
  L: Uint8Array;
}

export interface RotationRow {
  rank: number;
  offset: number;
  rotation: Uint8Array;
  lastByte: number;
}

export function validateBlockLength(length: number, maxBlockBytes = DEFAULT_MAX_BLOCK_BYTES): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new AppError('INVALID_INPUT', '块长度必须是非负安全整数。');
  }
  if (length > maxBlockBytes) {
    throw new AppError(
      'BLOCK_TOO_LARGE',
      `块长度 ${length} 超过上限 ${maxBlockBytes} 字节。`,
      413,
      { length, maxBlockBytes },
    );
  }
}

export function compareRotations(input: Uint8Array, leftOffset: number, rightOffset: number): number {
  const length = input.length;
  for (let step = 0; step < length; step += 1) {
    const left = input[(leftOffset + step) % length]!;
    const right = input[(rightOffset + step) % length]!;
    if (left !== right) return left - right;
  }
  return leftOffset - rightOffset;
}

export function sortedRotationOffsets(
  input: Uint8Array,
  maxBlockBytes = DEFAULT_MAX_BLOCK_BYTES,
): number[] {
  validateBlockLength(input.length, maxBlockBytes);
  if (input.length === 0) return [];
  const offsets = Array.from({ length: input.length }, (_unused, index) => index);
  offsets.sort((left, right) => compareRotations(input, left, right));
  return offsets;
}

export function bwt(input: Uint8Array, maxBlockBytes = DEFAULT_MAX_BLOCK_BYTES): BwtResult {
  validateBlockLength(input.length, maxBlockBytes);
  if (input.length === 0) return { length: 0, primary: 0, L: new Uint8Array(0) };
  const offsets = sortedRotationOffsets(input, maxBlockBytes);
  const L = new Uint8Array(input.length);
  let primary = -1;
  for (let rank = 0; rank < offsets.length; rank += 1) {
    const offset = offsets[rank]!;
    L[rank] = input[(offset - 1 + input.length) % input.length]!;
    if (offset === 0) primary = rank;
  }

  if (primary < 0 || primary >= input.length) {
    throw new AppError('INTERNAL_ERROR', '无法定位原始未旋转行。', 500);
  }
  return { length: input.length, primary, L };
}

export function buildRotationRows(input: Uint8Array, maxBlockBytes = DEFAULT_MAX_BLOCK_BYTES): RotationRow[] {
  validateBlockLength(input.length, maxBlockBytes);
  if (input.length === 0) return [];
  const offsets = sortedRotationOffsets(input, maxBlockBytes);
  return offsets.map((offset, rank) => {
    const rotation = new Uint8Array(input.length);
    for (let step = 0; step < input.length; step += 1) {
      rotation[step] = input[(offset + step) % input.length]!;
    }
    return {
      rank,
      offset,
      rotation,
      lastByte: input[(offset - 1 + input.length) % input.length]!,
    };
  });
}

export function validateTransformPayload(L: Uint8Array, primary: number): void {
  if (!(L instanceof Uint8Array)) {
    throw new AppError('INVALID_INPUT', 'L 必须是字节数组。');
  }
  if (!Number.isSafeInteger(primary) || primary < 0 || (L.length > 0 && primary >= L.length)) {
    throw new AppError('INVALID_PRIMARY', 'primary 必须位于排序后的行号范围内。', 400, {
      primary,
      rowCount: L.length,
    });
  }
  if (L.length === 0 && primary !== 0) {
    throw new AppError('INVALID_PRIMARY', '空块的 primary 必须为 0。');
  }
}

export function cumulativeCounts(L: Uint8Array): { counts: Uint32Array; cumulative: Uint32Array } {
  const counts = new Uint32Array(256);
  for (const byte of L) counts[byte] = (counts[byte] ?? 0) + 1;
  const cumulative = new Uint32Array(256);
  let running = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    cumulative[byte] = running;
    running += counts[byte] ?? 0;
  }
  return { counts, cumulative };
}

export interface LfStep {
  row: number;
  byte: number;
  occurrence: number;
  cumulativeBefore: number;
  nextRow: number;
}

export function lfStep(L: Uint8Array, row: number): LfStep {
  if (!Number.isSafeInteger(row) || row < 0 || row >= L.length) {
    throw new AppError('INVALID_PRIMARY', 'LF 查询行号越界。', 400, { row, rowCount: L.length });
  }
  const { cumulative } = cumulativeCounts(L);
  const byte = L[row]!;
  let occurrence = 0;
  for (let index = 0; index < row; index += 1) {
    if (L[index] === byte) occurrence += 1;
  }
  return {
    row,
    byte,
    occurrence,
    cumulativeBefore: cumulative[byte] ?? 0,
    nextRow: (cumulative[byte] ?? 0) + occurrence,
  };
}

export interface InverseOptions {
  outputBudget?: number;
}

export function inverseBwt(
  L: Uint8Array,
  primary: number,
  options: InverseOptions = {},
): Uint8Array {
  validateTransformPayload(L, primary);
  const outputBudget = options.outputBudget ?? DEFAULT_MAX_BLOCK_BYTES;
  if (!Number.isSafeInteger(outputBudget) || outputBudget < 0) {
    throw new AppError('OUTPUT_BUDGET_EXCEEDED', '输出预算必须是非负安全整数。');
  }
  if (L.length > outputBudget) {
    throw new AppError(
      'OUTPUT_BUDGET_EXCEEDED',
      `解码输出 ${L.length} 字节，超过预算 ${outputBudget} 字节。`,
      413,
      { outputLength: L.length, outputBudget },
    );
  }

  const rowOrder = Array.from({ length: L.length }, (_unused, index) => index);
  const restored = new Uint8Array(L.length);
  let currentPrimaryIdentity = primary;

  for (let position = L.length - 1; position >= 0; position -= 1) {
    restored[position] = L[currentPrimaryIdentity]!;
    const primaryIdentity = rowOrder[currentPrimaryIdentity]!;

    const nextOrder = rowOrder.map((identity, rank) => ({ identity, rank, byte: L[rank]! }));
    nextOrder.sort((left, right) => (left.byte === right.byte ? left.rank - right.rank : left.byte - right.byte));
    const orderedIdentities = nextOrder.map((item) => item.identity);
    const nextPrimaryIdentity = orderedIdentities.indexOf(primaryIdentity);
    rowOrder.splice(0, rowOrder.length, ...orderedIdentities);
    currentPrimaryIdentity = nextPrimaryIdentity;
  }

  return restored;
}

export function rebuildBySortedTable(L: Uint8Array, primary: number): Uint8Array {
  validateTransformPayload(L, primary);
  if (L.length === 0) return new Uint8Array(0);
  let table: Uint8Array[] = Array.from({ length: L.length }, () => new Uint8Array(0));
  for (let round = 0; round < L.length; round += 1) {
    table = table
      .map((row, index) => {
        const next = new Uint8Array(row.length + 1);
        next[0] = L[index]!;
        next.set(row, 1);
        return next;
      })
      .sort((left, right) => {
        const limit = Math.min(left.length, right.length);
        for (let index = 0; index < limit; index += 1) {
          if (left[index] !== right[index]) return left[index]! - right[index]!;
        }
        return left.length - right.length;
      });
  }
  return table[primary]!;
}
