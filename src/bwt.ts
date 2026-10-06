import { BwtError } from "./errors.js";

/**
 * BWT 变换版本。产物格式演进时递增，便于旧产物识别。
 */
export const BWT_VERSION = 1;

/** 默认块长度上限（字节）。BWT 比较法为 O(n^2 log n) 量级，限制在几千字节。 */
export const DEFAULT_MAX_BLOCK = 8192;

/**
 * 比较块 block 的两个循环移位（起点分别为 i、j）的字典序。
 * 先按旋转内容逐字节比较；内容完全相同（周期串）时按起点偏移升序打破平局，
 * 使产物确定。这是“不使用哨兵”的实现：不向输入追加任何字节。
 */
export function compareRotations(block: Uint8Array, i: number, j: number): number {
  const n = block.length;
  for (let step = 0; step < n; step++) {
    const a = block[(i + step) % n] as number;
    const b = block[(j + step) % n] as number;
    if (a !== b) return a - b;
  }
  return i - j;
}

export interface BwtResult {
  /** 块长度（字节），等于旋转行数。 */
  n: number;
  /** 最后一列 L，长度恒为 n。 */
  L: Uint8Array;
  /** 原始未旋转行（起点 0）在排序结果中的零基行号。空块固定为 0。 */
  primary: number;
  /** 排序后的起点偏移序列（解释用；解码并不需要它）。 */
  sa: number[];
}

/**
 * 正向 BWT：
 * 对全部 n 个循环移位按字节字典序排序，取每行最后一字节组成 L，
 * 并记录起点 0 所在行号 primary。
 * 复杂度：O(n^2 log n) 次字节比较（清晰直接的实现，非大文件流式方案）。
 */
export function bwtForward(block: Uint8Array): BwtResult {
  const n = block.length;
  if (n === 0) return { n: 0, L: new Uint8Array(0), primary: 0, sa: [] };

  const sa = Array.from({ length: n }, (_, idx) => idx);
  sa.sort((a, b) => compareRotations(block, a, b));

  const L = new Uint8Array(n);
  let primary = 0;
  for (let row = 0; row < n; row++) {
    const start = sa[row] as number;
    L[row] = block[(start + n - 1) % n] as number;
    if (start === 0) primary = row;
  }
  return { n, L, primary, sa };
}

/**
 * 生成显式旋转表（仅用于短块解释与核对，不参与正式解码）。
 * 返回按字典序排序后的行，每行包含起点、完整旋转字节、是否为原始行、最后一字节。
 */
export interface RotationRow {
  row: number;
  start: number;
  rotation: number[];
  last: number;
  isPrimary: boolean;
}

export function rotationTable(block: Uint8Array, sa?: number[]): RotationRow[] {
  const n = block.length;
  const order = sa ?? (bwtForward(block).sa);
  const rows: RotationRow[] = [];
  for (let row = 0; row < n; row++) {
    const start = order[row] as number;
    const rotation: number[] = [];
    for (let step = 0; step < n; step++) {
      rotation.push(block[(start + step) % n] as number);
    }
    rows.push({
      row,
      start,
      rotation,
      last: block[(start + n - 1) % n] as number,
      isPrimary: start === 0,
    });
  }
  return rows;
}

export interface LfTables {
  /** C[c]：排序首列中，字节 c 之前出现的字节总数（更小字节计数之和）。 */
  C: number[];
  /** occBefore[row]：L[row] 在 L[0..row-1] 中此前已出现次数（零基出现次数）。 */
  occBefore: number[];
  /** LF(row) = C[L[row]] + occBefore[row]。 */
  lf: number[];
}

/** 计算 LF 映射所需的计数表、出现次数表与 LF 行号表。 */
export function buildLfTables(L: Uint8Array): LfTables {
  const n = L.length;
  const counts = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i++) {
    const c = L[i] as number;
    counts[c] = (counts[c] as number) + 1;
  }

  const C = new Array<number>(256).fill(0);
  let cumulative = 0;
  for (let c = 0; c < 256; c++) {
    C[c] = cumulative;
    cumulative += counts[c] as number;
  }

  const seen = new Array<number>(256).fill(0);
  const occBefore = new Array<number>(n).fill(0);
  const lf = new Array<number>(n).fill(0);
  for (let row = 0; row < n; row++) {
    const c = L[row] as number;
    occBefore[row] = seen[c] as number;
    lf[row] = (C[c] as number) + (seen[c] as number);
    seen[c] = (seen[c] as number) + 1;
  }
  return { C, occBefore, lf };
}

/** 单个 LF 步骤的解释信息（零基口径）。 */
export interface LfStep {
  row: number;
  byte: number;
  occurrence: number;
  countBefore: number;
  nextRow: number;
}

export function lfStep(L: Uint8Array, tables: LfTables, row: number): LfStep {
  const n = L.length;
  if (!Number.isInteger(row) || row < 0 || row >= n) {
    throw new BwtError(
      "PRIMARY_OUT_OF_RANGE",
      `行号 ${row} 越界：非空块合法范围为 0..${n - 1}（空块无行）`
    );
  }
  const byte = L[row] as number;
  return {
    row,
    byte,
    occurrence: tables.occBefore[row] as number,
    countBefore: tables.C[byte] as number,
    nextRow: tables.lf[row] as number,
  };
}

/**
 * 逆向 BWT（仅依赖 L 与 primary，不读取原文或旋转矩阵）：
 * 从 primary 行开始，沿 LF(row)=C[L[row]] + occBefore(row) 前进；
 * LF 每走一步对应原块“向前提取一个字节”，故把依次遇到的 L[row]
 * 从答案尾部向前回填，最后一次回到起点时正好填满第 0 位，避免整体旋转。
 * 复杂度 O(n)，额外空间 O(n)。
 */
export function bwtInverse(L: Uint8Array, primary: number, outputBudget?: number): Uint8Array {
  const n = L.length;
  if (n === 0) {
    if (primary !== 0) {
      throw new BwtError("PRIMARY_OUT_OF_RANGE", "空块的 primary 必须为 0", { primary });
    }
    return new Uint8Array(0);
  }
  if (!Number.isInteger(primary) || primary < 0 || primary >= n) {
    throw new BwtError(
      "PRIMARY_OUT_OF_RANGE",
      `primary ${primary} 越界：必须落在行数范围 0..${n - 1}`,
      { primary, rows: n }
    );
  }
  if (outputBudget !== undefined && n > outputBudget) {
    throw new BwtError(
      "OUTPUT_BUDGET_EXCEEDED",
      `输出长度 ${n} 超过预算 ${outputBudget}`,
      { length: n, budget: outputBudget }
    );
  }

  const tables = buildLfTables(L);
  const out = new Uint8Array(n);
  let row = primary;
  for (let pos = n - 1; pos >= 0; pos--) {
    out[pos] = L[row] as number;
    row = tables.lf[row] as number;
  }
  return out;
}

/**
 * 另一种逆变换核对法：逐轮表重建。
 * 反复把 L 作为新列前置到当前表前、按行整体字节序稳定重排，
 * 第 n 轮后第 primary 行即为原块。仅用于测试/解释，复杂度 O(n^2 log n)。
 */
export function bwtInverseByReconstruction(
  L: Uint8Array,
  primary: number,
  outputBudget?: number
): Uint8Array {
  const n = L.length;
  if (n === 0) return bwtInverse(L, primary, outputBudget);
  if (outputBudget !== undefined && n > outputBudget) {
    throw new BwtError(
      "OUTPUT_BUDGET_EXCEEDED",
      `输出长度 ${n} 超过预算 ${outputBudget}`
    );
  }
  if (!Number.isInteger(primary) || primary < 0 || primary >= n) {
    throw new BwtError("PRIMARY_OUT_OF_RANGE", `primary ${primary} 越界`);
  }

  // 表重建法（与 LF 无关的独立核对实现）：
  // 反复对索引按“L[idx] 前缀 + 上一轮该行内容”排序，
  // 第 n 轮后第 primary 个索引指向的 [L[idx], 旧行...] 即为原块。
  let rows: number[][] = Array.from({ length: n }, () => []);
  let indices = Array.from({ length: n }, (_, i) => i);
  for (let round = 0; round < n; round++) {
    indices.sort((x, y) => {
      const rx = rows[x]!;
      const ry = rows[y]!;
      const lx = L[x] as number;
      const ly = L[y] as number;
      if (lx !== ly) return lx - ly;
      for (let k = 0; k < rx.length; k++) {
        const d = (rx[k] as number) - (ry[k] as number);
        if (d !== 0) return d;
      }
      return x - y;
    });
    if (round === n - 1) break;
    rows = indices.map((idx) => [L[idx] as number, ...rows[idx]!]);
  }
  const primaryIdx = indices[primary]!;
  return Uint8Array.from([L[primaryIdx] as number, ...rows[primaryIdx]!]);
}
