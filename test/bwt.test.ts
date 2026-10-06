import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bwt,
  buildRotationRows,
  compareRotations,
  inverseBwt,
  lfStep,
  rebuildBySortedTable,
} from '../src/core/bwt.js';
import { decodeHex } from '../src/core/bytes.js';
import { AppError } from '../src/errors.js';

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

test('banana has deterministic L=nnbaaa and primary=3', () => {
  const result = bwt(utf8('banana'));
  assert.equal(result.length, 6);
  assert.equal(result.primary, 3);
  assert.deepEqual(result.L, utf8('nnbaaa'));
});

test('LF inverse restores banana from primary in right-to-left fill order', () => {
  const input = utf8('banana');
  const result = bwt(input);
  const restored = inverseBwt(result.L, result.primary);
  assert.deepEqual(restored, input);

  assert.deepEqual(lfStep(result.L, 3), {
    row: 3,
    byte: 'a'.charCodeAt(0),
    occurrence: 0,
    cumulativeBefore: 0,
    nextRow: 0,
  });
});

test('empty and one-byte blocks round-trip', () => {
  const empty = bwt(new Uint8Array(0));
  assert.deepEqual(empty.L, new Uint8Array(0));
  assert.equal(empty.primary, 0);
  assert.deepEqual(inverseBwt(empty.L, empty.primary), new Uint8Array(0));

  for (const byte of [0, 65, 255]) {
    const input = Uint8Array.from([byte]);
    const result = bwt(input);
    assert.deepEqual(result.L, input);
    assert.equal(result.primary, 0);
    assert.deepEqual(inverseBwt(result.L, result.primary), input);
  }
});

test('periodic abab ties are broken by ascending source offset', () => {
  const input = utf8('abab');
  const result = bwt(input);
  const rows = buildRotationRows(input);
  assert.deepEqual(rows.map((row) => row.offset), [0, 2, 1, 3]);
  assert.deepEqual(Uint8Array.from(rows, (row) => row.lastByte), utf8('bbaa'));
  assert.equal(result.primary, 0);
  assert.deepEqual(inverseBwt(result.L, result.primary), input);
});

test('identical bytes have stable offset tie-break and exact primary', () => {
  const input = Uint8Array.from([7, 7, 7]);
  const result = bwt(input);
  const rows = buildRotationRows(input);
  assert.deepEqual(rows.map((row) => row.offset), [0, 1, 2]);
  assert.equal(result.primary, 0);
  assert.deepEqual(inverseBwt(result.L, result.primary), input);
});

test('all 256 byte values, zero-bearing binary, and random blocks round-trip', () => {
  const allBytes = Uint8Array.from({ length: 256 }, (_unused, index) => index);
  const allResult = bwt(allBytes);
  assert.deepEqual(inverseBwt(allResult.L, allResult.primary), allBytes);

  const zeroBinary = decodeHex('00ff00017f80ab00');
  const zeroResult = bwt(zeroBinary);
  assert.deepEqual(inverseBwt(zeroResult.L, zeroResult.primary), zeroBinary);

  for (let seed = 1; seed <= 20; seed += 1) {
    let state = seed * 1103515245 + 12345;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state & 255;
    };
    const input = Uint8Array.from({ length: 1 + (seed * 37) % 300 }, random);
    const result = bwt(input);
    assert.deepEqual(inverseBwt(result.L, result.primary), input);
  }
});

test('explicit rotation table independently agrees with forward order', () => {
  const input = utf8('abracadabra');
  const result = bwt(input);
  const rows = buildRotationRows(input);
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(compareRotations(input, rows[index - 1]!.offset, rows[index]!.offset) < 0);
  }
  assert.deepEqual(Uint8Array.from(rows, (row) => row.lastByte), result.L);
  assert.equal(rows[result.primary]!.offset, 0);
});

test('independent per-round table rebuild agrees with LF inverse', () => {
  for (const text of ['banana', 'abab', 'mississippi']) {
    const input = utf8(text);
    const result = bwt(input);
    assert.deepEqual(rebuildBySortedTable(result.L, result.primary), input);
  }
  const binary = decodeHex('000100ff0200');
  const result = bwt(binary);
  assert.deepEqual(rebuildBySortedTable(result.L, result.primary), binary);
});

test('rejects invalid primary, length mismatch, and output budget', () => {
  const L = utf8('nnbaaa');
  assert.throws(() => inverseBwt(L, -1), (error: unknown) => error instanceof AppError && error.code === 'INVALID_PRIMARY');
  assert.throws(() => inverseBwt(L, 6), (error: unknown) => error instanceof AppError && error.code === 'INVALID_PRIMARY');
  assert.throws(() => inverseBwt(new Uint8Array(0), 1), (error: unknown) => error instanceof AppError && error.code === 'INVALID_PRIMARY');
  assert.throws(() => inverseBwt(L, 3, { outputBudget: 5 }), (error: unknown) => error instanceof AppError && error.code === 'OUTPUT_BUDGET_EXCEEDED');
});
