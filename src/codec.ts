import { createHash } from "node:crypto";
import { BwtError } from "./errors.js";
import { BWT_VERSION, DEFAULT_MAX_BLOCK } from "./bwt.js";

/** L 的无歧义编码方式：base64 或 hex；空字节串两者都编码为空字符串。 */
export type LEncoding = "base64" | "hex";

export function encodeBytes(bytes: Uint8Array, encoding: LEncoding): string {
  return Buffer.from(bytes).toString(encoding);
}

export function decodeBytes(text: string, encoding: LEncoding): Uint8Array {
  const buf = Buffer.from(text, encoding);
  if (encoding === "hex") {
    const normalized = text.trim().replace(/\s+/g, "").toLowerCase();
    if (normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
      throw new BwtError("INVALID_HEX", "非法十六进制：需为偶数个 0-9a-f 字符", {
        input: text.slice(0, 64),
      });
    }
    const reparsed = Buffer.from(normalized, "hex");
    if (reparsed.toString("hex") !== normalized) {
      throw new BwtError("INVALID_HEX", "非法十六进制编码");
    }
    return new Uint8Array(reparsed);
  }
  // base64：严格重编码校验，拒绝被静默截断的输入
  if (buf.toString("base64").replace(/=+$/, "") !== text.trim().replace(/=+$/, "").replace(/\s+/g, "")) {
    throw new BwtError("INVALID_BASE64", "非法 base64 编码");
  }
  return new Uint8Array(buf);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/** 把任意输入按指定来源解析为 0..255 的字节块，并执行长度校验。 */
export function parseBlock(
  payload: { encoding?: string; data?: string; text?: string },
  maxBlock: number = DEFAULT_MAX_BLOCK
): { bytes: Uint8Array; sourceEncoding: string } {
  const encoding = payload.encoding ?? (payload.text !== undefined ? "utf8" : "base64");
  let bytes: Uint8Array;
  if (encoding === "utf8") {
    const text = payload.text ?? payload.data ?? "";
    bytes = new Uint8Array(Buffer.from(text, "utf8"));
  } else if (encoding === "hex") {
    bytes = decodeBytes(payload.data ?? "", "hex");
  } else if (encoding === "base64") {
    bytes = decodeBytes(payload.data ?? "", "base64");
  } else {
    throw new BwtError(
      "UNSUPPORTED_ENCODING",
      `不支持的编码 ${encoding}，可选 utf8 / hex / base64`
    );
  }
  if (bytes.length > maxBlock) {
    throw new BwtError(
      "BLOCK_TOO_LARGE",
      `块长度 ${bytes.length} 超过上限 ${maxBlock} 字节`,
      { length: bytes.length, maxBlock }
    );
  }
  return { bytes, sourceEncoding: encoding };
}

export interface ExportEnvelope {
  format: "bwt-byte-block";
  version: number;
  n: number;
  primary: number;
  lEncoding: LEncoding;
  L: string;
  digest?: {
    algorithm: "sha256";
    /** 原始字节块摘要；解码不依赖它，仅用于独立校验/比较。 */
    original: string;
  };
  createdAt: string;
}

export interface EnvelopeInputs {
  n: number;
  primary: number;
  L: Uint8Array;
  lEncoding?: LEncoding;
  originalDigest?: string;
}

export function buildEnvelope(inputs: EnvelopeInputs): ExportEnvelope {
  const lEncoding = inputs.lEncoding ?? "base64";
  const envelope: ExportEnvelope = {
    format: "bwt-byte-block",
    version: BWT_VERSION,
    n: inputs.n,
    primary: inputs.primary,
    lEncoding,
    L: encodeBytes(inputs.L, lEncoding),
    createdAt: new Date().toISOString(),
  };
  if (inputs.originalDigest) {
    envelope.digest = { algorithm: "sha256", original: inputs.originalDigest };
  }
  return envelope;
}

export interface ParsedEnvelope {
  n: number;
  primary: number;
  L: Uint8Array;
  version: number;
  originalDigest?: string;
}

/** 解析并严格校验导出结构：长度、版本、primary 范围、L 字节数。 */
export function parseEnvelope(raw: unknown, outputBudget?: number): ParsedEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw new BwtError("BAD_REQUEST", "导出结构必须是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== "bwt-byte-block") {
    throw new BwtError("BAD_REQUEST", "缺少或错误的 format 字段", { format: obj.format });
  }
  if (obj.version !== BWT_VERSION) {
    throw new BwtError("BAD_REQUEST", `不支持的产物版本 ${String(obj.version)}`, {
      expected: BWT_VERSION,
    });
  }
  const n = obj.n;
  const primary = obj.primary;
  if (!Number.isInteger(n) || (n as number) < 0) {
    throw new BwtError("LENGTH_MISMATCH", "n 必须是非负整数", { n });
  }
  if (!Number.isInteger(primary)) {
    throw new BwtError("PRIMARY_OUT_OF_RANGE", "primary 必须是整数", { primary });
  }
  const lEncoding = obj.lEncoding === "hex" || obj.lEncoding === "base64" ? obj.lEncoding : null;
  if (lEncoding === null || typeof obj.L !== "string") {
    throw new BwtError("BAD_REQUEST", "需要 lEncoding(base64|hex) 与字符串 L");
  }
  let L: Uint8Array;
  try {
    L = decodeBytes(obj.L, lEncoding);
  } catch (err) {
    throw err instanceof BwtError
      ? err
      : new BwtError("BAD_REQUEST", "L 解码失败");
  }
  if (L.length !== (n as number)) {
    throw new BwtError("LENGTH_MISMATCH", `L 长度 ${L.length} 与 n ${n} 不符`, {
      lLength: L.length,
      n,
    });
  }
  const rows = (n as number);
  if (rows === 0) {
    if ((primary as number) !== 0) {
      throw new BwtError("PRIMARY_OUT_OF_RANGE", "空块 primary 必须为 0", { primary });
    }
  } else if ((primary as number) < 0 || (primary as number) >= rows) {
    throw new BwtError(
      "PRIMARY_OUT_OF_RANGE",
      `primary ${primary} 不在行数范围 0..${rows - 1}`
    );
  }
  if (outputBudget !== undefined && rows > outputBudget) {
    throw new BwtError(
      "OUTPUT_BUDGET_EXCEEDED",
      `输出长度 ${rows} 超过预算 ${outputBudget}`
    );
  }
  let originalDigest: string | undefined;
  if (typeof obj.digest === "object" && obj.digest !== null) {
    const d = (obj.digest as Record<string, unknown>).original;
    if (typeof d === "string") originalDigest = d;
  }
  return { n: rows, primary: primary as number, L, version: obj.version as number, originalDigest };
}
