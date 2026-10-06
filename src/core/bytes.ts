import { AppError } from '../errors.js';

export type ByteInputFormat = 'utf8' | 'hex' | 'base64' | 'file';

export interface ByteInput {
  bytes: Uint8Array;
  format: ByteInputFormat;
  sourceName?: string;
}

export function decodeHex(value: string): Uint8Array {
  const compact = value.trim();
  if (compact.length === 0) return new Uint8Array(0);
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(compact)) {
    throw new AppError('INVALID_HEX', '十六进制必须由偶数个 0-9/a-f 字符组成。');
  }
  const result = new Uint8Array(compact.length / 2);
  for (let i = 0; i < result.length; i += 1) {
    result[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

export function decodeBase64(value: string): Uint8Array {
  const compact = value.trim();
  if (compact.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new AppError('INVALID_BASE64', 'Base64 编码非法。');
  }
  try {
    const binary = atob(compact);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new AppError('INVALID_BASE64', 'Base64 编码非法。');
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function decodeTextInput(format: 'utf8' | 'hex' | 'base64', value: string): Uint8Array {
  if (format === 'utf8') return new TextEncoder().encode(value);
  if (format === 'hex') return decodeHex(value);
  return decodeBase64(value);
}

export function tryDecodeUtf8(bytes: Uint8Array): { text: string; ok: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), ok: true };
  } catch {
    return { text: '', ok: false };
  }
}

export function renderByte(byte: number): string {
  if (byte >= 32 && byte <= 126) return String.fromCharCode(byte);
  return `\\x${byte.toString(16).padStart(2, '0')}`;
}

export function renderBytes(bytes: Uint8Array): string {
  return Array.from(bytes, renderByte).join('');
}
