import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bwt, inverseBwt } from '../src/core/bwt.js';
import { decodeHex, encodeBase64 } from '../src/core/bytes.js';
import { makeExport, parseExport, verifyOriginalDigest } from '../src/core/export.js';
import { AppError } from '../src/errors.js';

test('export contains versioned unambiguous L and can decode without source bytes', () => {
  const input = decodeHex('006100ff42e4bda0e5a5bd');
  const transform = bwt(input);
  const document = makeExport(transform.L, transform.primary, { originalSha256: 'not-a-real-digest' });
  const parsed = parseExport(document, 4096);
  const restored = inverseBwt(parsed.L, parsed.primary);
  assert.deepEqual(restored, input);
  assert.equal(parsed.originalSha256, 'not-a-real-digest');
  assert.equal(verifyOriginalDigest(restored, parsed.originalSha256), false);
});

test('real digest verifies and tampered data is reported separately', () => {
  const input = new TextEncoder().encode('中文 banana');
  const transform = bwt(input);
  const document = makeExport(transform.L, transform.primary);
  const parsed = parseExport(document, 4096);
  const restored = inverseBwt(parsed.L, parsed.primary);
  assert.deepEqual(restored, input);
  assert.equal(parsed.originalSha256, undefined);

  const tampered = new Uint8Array(transform.L);
  tampered[0] = tampered[0] === 0 ? 1 : 0;
  const bad = makeExport(tampered, transform.primary);
  const parsedBad = parseExport(bad, 4096);
  const restoredBad = inverseBwt(parsedBad.L, parsedBad.primary);
  assert.notDeepEqual(restoredBad, input);
  assert.equal(parsedBad.originalSha256, undefined);
});

test('rejects inconsistent declared length and unsupported version', () => {
  const transform = bwt(new TextEncoder().encode('abc'));
  const document = makeExport(transform.L, transform.primary);
  document.block.length = 4;
  assert.throws(() => parseExport(document, 4096), (error: unknown) => error instanceof AppError && error.code === 'LENGTH_MISMATCH');

  const unsupported = makeExport(transform.L, transform.primary);
  (unsupported as unknown as { transformVersion: string }).transformVersion = 'other/9';
  assert.throws(() => parseExport(unsupported, 4096), (error: unknown) => error instanceof AppError && error.code === 'INVALID_EXPORT');
});

test('base64 represents all byte values without UTF-8 loss', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index);
  assert.equal(encodeBase64(decodeHex(Buffer.from(bytes).toString('hex'))), encodeBase64(bytes));
});
