import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  bwtForward,
  bwtInverse,
  bwtInverseByReconstruction,
  buildLfTables,
  rotationTable,
  compareRotations,
} from "../src/bwt.ts";
import { BwtError } from "../src/errors.js";
import { buildEnvelope, parseEnvelope, sha256Hex } from "../src/codec.js";

function roundtrip(bytes: Uint8Array) {
  const f = bwtForward(bytes);
  assert.equal(f.L.length, bytes.length);
  assert.equal(f.sa.length, bytes.length);
  if (bytes.length > 0) assert.ok(f.primary >= 0 && f.primary < bytes.length);
  const back = bwtInverse(f.L, f.primary);
  assert.ok(Buffer.from(back).equals(Buffer.from(bytes)), "LF 逆变换应还原原文");
  const rebuilt = bwtInverseByReconstruction(f.L, f.primary);
  assert.ok(Buffer.from(rebuilt).equals(Buffer.from(bytes)), "逐轮重建法应还原原文");
  return f;
}

test("banana: L=nnbaaa, primary=3", () => {
  const f = roundtrip(new TextEncoder().encode("banana"));
  assert.equal(Buffer.from(f.L).toString("latin1"), "nnbaaa");
  assert.equal(f.primary, 3);
});

test("空块固定 L 为空、primary 为 0", () => {
  const f = bwtForward(new Uint8Array(0));
  assert.deepEqual(Array.from(f.L), []);
  assert.equal(f.primary, 0);
  assert.deepEqual(Array.from(bwtInverse(f.L, f.primary)), []);
});

test("单字节", () => {
  const f = roundtrip(Uint8Array.from([42]));
  assert.deepEqual(Array.from(f.L), [42]);
  assert.equal(f.primary, 0);
});

test("全部 256 种字节值往返", () => {
  roundtrip(Uint8Array.from({ length: 256 }, (_, i) => i));
});

test("全部 256 字节的乱序排列", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => (i * 31 + 7) % 256);
  roundtrip(bytes);
});

test("周期串 abab：重复旋转按起点偏移平局，结果确定", () => {
  const f = roundtrip(new TextEncoder().encode("abab"));
  // 两次调用必须一致
  const f2 = bwtForward(new TextEncoder().encode("abab"));
  assert.ok(Buffer.from(f.L).equals(Buffer.from(f2.L)));
  assert.equal(f.primary, f2.primary);
});

test("全相同字节 aaaa", () => {
  const f = roundtrip(new TextEncoder().encode("aaaa"));
  assert.deepEqual(Array.from(f.L), [97, 97, 97, 97]);
  // 全部旋转内容相同，起点偏移升序 -> 原始行（起点0）排第 0 行
  assert.equal(f.primary, 0);
});

test("含零字节二进制往返", () => {
  roundtrip(Uint8Array.from([0, 65, 0, 66, 255, 0]));
});

test("随机字节大量往返", () => {
  for (let seed = 1; seed <= 20; seed++) {
    let s = seed * 9973;
    const n = 1 + (s % 300);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = s % 256;
    }
    roundtrip(bytes);
  }
});

test("短块：显式旋转表与排序规则独立核对", () => {
  const block = new TextEncoder().encode("banana");
  const f = bwtForward(block);
  const rows = rotationTable(block, f.sa);
  // 每一行必须是真实循环移位
  for (const r of rows) {
    const expected = Array.from({ length: block.length }, (_, k) => block[(r.start + k) % block.length]);
    assert.deepEqual(r.rotation, expected);
  }
  // 相邻行必须满足 compareRotations 非递减；相同内容时起点升序
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    assert.ok(compareRotations(block, prev.start, cur.start) <= 0);
  }
  // L 必须等于每行最后一字节
  for (const r of rows) {
    assert.equal(r.last, f.L[r.row]);
  }
});

test("LF 表：C 为更小字节计数，occBefore 为零基出现次数", () => {
  const block = new TextEncoder().encode("banana");
  const f = bwtForward(block);
  const t = buildLfTables(f.L);
  // L = nnbaaa
  assert.equal(t.C[97], 0); // a 之前没有更小字节
  assert.equal(t.C[98], 3); // b 之前有 3 个 a
  assert.equal(t.C[110], 4); // n 之前有 3a+1b
  // L[0]='n' 的此前出现次数为 0，LF=4
  assert.equal(t.occBefore[0], 0);
  assert.equal(t.lf[0], 4);
});

test("错误 primary 越界被拒绝", () => {
  assert.throws(() => bwtInverse(Uint8Array.from([1, 2]), 2), (e: unknown) =>
    e instanceof BwtError && e.code === "PRIMARY_OUT_OF_RANGE");
  assert.throws(() => bwtInverse(Uint8Array.from([1, 2]), -1), (e: unknown) =>
    e instanceof BwtError && e.code === "PRIMARY_OUT_OF_RANGE");
  assert.throws(() => bwtInverse(new Uint8Array(0), 1), (e: unknown) =>
    e instanceof BwtError && e.code === "PRIMARY_OUT_OF_RANGE");
});

test("输出预算超限被拒绝", () => {
  assert.throws(
    () => bwtInverse(Uint8Array.from([1, 2, 3]), 0, 2),
    (e: unknown) => e instanceof BwtError && e.code === "OUTPUT_BUDGET_EXCEEDED"
  );
});

test("导出结构：长度不符 / 非法编码被拒绝", () => {
  const env = buildEnvelope({ n: 2, primary: 0, L: Uint8Array.from([1, 2]) });
  const badLen = { ...env, n: 3 };
  assert.throws(() => parseEnvelope(badLen), (e: unknown) =>
    e instanceof BwtError && e.code === "LENGTH_MISMATCH");
  assert.throws(() => parseEnvelope({ ...env, L: "zzz!!" }), (e: unknown) =>
    e instanceof BwtError);
  assert.throws(() => parseEnvelope({ ...env, primary: 9 }), (e: unknown) =>
    e instanceof BwtError && e.code === "PRIMARY_OUT_OF_RANGE");
});

test("摘要校验：内容一致才通过，可解码不等于来源认证", () => {
  const bytes = new TextEncoder().encode("banana");
  const f = bwtForward(bytes);
  const env = buildEnvelope({ n: f.n, primary: f.primary, L: f.L, originalDigest: sha256Hex(bytes) });
  const parsed = parseEnvelope(env);
  const back = bwtInverse(parsed.L, parsed.primary);
  assert.equal(sha256Hex(back), parsed.originalDigest);
});

test("hex 导出/导入往返（含空块）", () => {
  const bytes = Uint8Array.from([0, 255, 16, 0]);
  const f = bwtForward(bytes);
  const env = buildEnvelope({ n: f.n, primary: f.primary, L: f.L, lEncoding: "hex" });
  const parsed = parseEnvelope(env);
  assert.ok(Buffer.from(bwtInverse(parsed.L, parsed.primary)).equals(Buffer.from(bytes)));

  const empty = bwtForward(new Uint8Array(0));
  const eEnv = buildEnvelope({ n: 0, primary: 0, L: empty.L, lEncoding: "hex" });
  const eParsed = parseEnvelope(eEnv);
  assert.equal(eParsed.L.length, 0);
  assert.deepEqual(Array.from(bwtInverse(eParsed.L, 0)), []);
});
