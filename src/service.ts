import { BwtStore } from "./db.js";
import {
  bwtForward,
  bwtInverse,
  buildLfTables,
  rotationTable,
  lfStep,
  type LfStep,
  type RotationRow,
  DEFAULT_MAX_BLOCK,
} from "./bwt.js";
import {
  buildEnvelope,
  parseBlock,
  parseEnvelope,
  sha256Hex,
  type ExportEnvelope,
  type LEncoding,
} from "./codec.js";
import { BwtError } from "./errors.js";

export interface TransformOutcome {
  id: string;
  n: number;
  primary: number;
  lEncoding: LEncoding;
  L: string;
  inputSha256: string;
  envelope: ExportEnvelope;
}

export class BwtService {
  readonly maxBlock: number;
  readonly maxLimitBytes: number;

  constructor(private store: BwtStore, maxBlock: number = DEFAULT_MAX_BLOCK) {
    this.maxBlock = maxBlock;
    // base64 约膨胀 4/3，再预留 JSON 包装余量
    this.maxLimitBytes = Math.ceil(maxBlock * 1.4) + 4096;
  }

  list(limit: number, offset: number) {
    return this.store.list(limit, offset);
  }

  transform(
    payload: { encoding?: string; data?: string; text?: string },
    options: { lEncoding?: LEncoding; withDigest?: boolean } = {}
  ): TransformOutcome {
    const { bytes, sourceEncoding } = parseBlock(payload, this.maxBlock);
    const result = bwtForward(bytes);
    const inputSha256 = sha256Hex(bytes);
    const id = inputSha256.slice(0, 16);
    const lEncoding = options.lEncoding ?? "base64";
    const envelope = buildEnvelope({
      n: result.n,
      primary: result.primary,
      L: result.L,
      lEncoding,
      originalDigest: options.withDigest === false ? undefined : inputSha256,
    });
    this.store.insert({
      id,
      n: result.n,
      primary: result.primary,
      l_encoding: lEncoding,
      l_data: envelope.L,
      input_sha256: inputSha256,
      source_encoding: sourceEncoding,
      max_block: this.maxBlock,
    });
    return {
      id,
      n: result.n,
      primary: result.primary,
      lEncoding,
      L: envelope.L,
      inputSha256,
      envelope,
    };
  }

  getRecordOrThrow(id: string) {
    const rec = this.store.get(id);
    if (!rec) throw new BwtError("RECORD_NOT_FOUND", `未找到变换记录 ${id}`, { id });
    return rec;
  }

  loadEnvelope(source: { recordId?: string; envelope?: unknown }, outputBudget?: number) {
    if (source.recordId) {
      const rec = this.getRecordOrThrow(source.recordId);
      const env = buildEnvelope({
        n: rec.n,
        primary: rec.primary,
        L: Buffer.from(rec.l_data, rec.l_encoding),
        lEncoding: rec.l_encoding,
        originalDigest: rec.input_sha256 ?? undefined,
      });
      return parseEnvelope(env, outputBudget ?? this.maxBlock);
    }
    if (source.envelope !== undefined) {
      return parseEnvelope(source.envelope, outputBudget ?? this.maxBlock);
    }
    throw new BwtError("BAD_REQUEST", "需要 recordId 或 envelope");
  }

  decode(
    source: { recordId?: string; envelope?: unknown },
    options: { outputBudget?: number } = {}
  ): { bytes: Uint8Array; n: number; primary: number; digest?: string; digestVerified?: boolean } {
    const parsed = this.loadEnvelope(source, options.outputBudget ?? this.maxBlock);
    const bytes = bwtInverse(parsed.L, parsed.primary, options.outputBudget ?? this.maxBlock);
    let digestVerified: boolean | undefined;
    if (parsed.originalDigest) {
      digestVerified = sha256Hex(bytes) === parsed.originalDigest;
    }
    return {
      bytes,
      n: parsed.n,
      primary: parsed.primary,
      digest: parsed.originalDigest,
      digestVerified,
    };
  }

  rotations(
    source: {
      recordId?: string;
      envelope?: unknown;
      block?: { encoding?: string; data?: string; text?: string };
    },
    page: number,
    pageSize: number
  ): { rows: RotationRow[]; total: number; page: number; pageSize: number; primary?: number } {
    let bytes: Uint8Array;
    let primary: number | undefined;
    if (source.block) {
      const fwd = bwtForward(parseBlock(source.block, this.maxBlock).bytes);
      bytes = bwtInverse(fwd.L, fwd.primary, this.maxBlock);
      primary = fwd.primary;
    } else {
      const decoded = this.decode(source);
      bytes = decoded.bytes;
      primary = decoded.primary;
    }
    const all = rotationTable(bytes);
    const total = all.length;
    if (total === 0) return { rows: [], total: 0, page: 0, pageSize, primary: 0 };
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page < 0 || page > maxPage) {
      throw new BwtError("PAGE_OUT_OF_RANGE", `页码 ${page} 越界，合法范围 0..${maxPage}`, {
        maxPage,
      });
    }
    return {
      rows: all.slice(page * pageSize, page * pageSize + pageSize),
      total,
      page,
      pageSize,
      primary,
    };
  }

  lfStep(source: { recordId?: string; envelope?: unknown }, row: number): LfStep {
    const parsed = this.loadEnvelope(source);
    return lfStep(parsed.L, buildLfTables(parsed.L), row);
  }

  /** 比较给定字节与产物摘要：只比较摘要，不把“可解码”当作来源认证。 */
  compareDigest(
    source: { recordId?: string; envelope?: unknown },
    payload: { encoding?: string; data?: string; text?: string }
  ): { match: boolean; envelopeDigest?: string; suppliedDigest: string } {
    const parsed = this.loadEnvelope(source);
    const supplied = sha256Hex(parseBlock(payload, this.maxBlock).bytes);
    return {
      match: parsed.originalDigest !== undefined && parsed.originalDigest === supplied,
      envelopeDigest: parsed.originalDigest,
      suppliedDigest: supplied,
    };
  }

  exportEnvelope(source: { recordId?: string; envelope?: unknown }): ExportEnvelope {
    const parsed = this.loadEnvelope(source);
    return buildEnvelope({
      n: parsed.n,
      primary: parsed.primary,
      L: parsed.L,
      originalDigest: parsed.originalDigest,
    });
  }
}
