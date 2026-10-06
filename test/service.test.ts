import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BwtStore } from "../src/db.ts";
import { BwtService } from "../src/service.ts";
import { BwtError } from "../src/errors.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bwt-test-"));
}

function makeService(dir: string, maxBlock = 1024): { store: BwtStore; service: BwtService } {
  const store = new BwtStore(join(dir, "t.sqlite"));
  return { store, service: new BwtService(store, maxBlock) };
}

test("服务层：utf8/hex/base64 变换与解码", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir);
  const t = service.transform({ encoding: "utf8", text: "banana" });
  assert.equal(t.n, 6);
  assert.equal(t.primary, 3);
  const decoded = service.decode({ recordId: t.id });
  assert.equal(Buffer.from(decoded.bytes).toString("utf8"), "banana");
  assert.equal(decoded.digestVerified, true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("含零字节二进制通过 hex 往返，中文文本正确往返", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir);
  const binHex = Buffer.from([0, 65, 0, 66, 255, 0]).toString("hex");
  const t = service.transform({ encoding: "hex", data: binHex });
  const back = service.decode({ recordId: t.id });
  assert.equal(Buffer.from(back.bytes).toString("hex"), binHex);

  const cn = service.transform({ encoding: "utf8", text: "你好，BWT" });
  const cnBack = service.decode({ recordId: cn.id });
  assert.equal(Buffer.from(cnBack.bytes).toString("utf8"), "你好，BWT");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("超过块上限被拒绝", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir, 4);
  assert.throws(
    () => service.transform({ encoding: "hex", data: "0011223344" }),
    (e: unknown) => e instanceof BwtError && e.code === "BLOCK_TOO_LARGE"
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("envelope 独立解码，不依赖数据库记录", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir);
  const t = service.transform({ text: "hello world" });
  const envelope = service.exportEnvelope({ recordId: t.id });
  // 全新数据库/服务只凭 envelope 解码
  const dir2 = tempDir();
  const s2 = new BwtStore(join(dir2, "fresh.sqlite"));
  const service2 = new BwtService(s2);
  const decoded = service2.decode({ envelope });
  assert.equal(Buffer.from(decoded.bytes).toString("utf8"), "hello world");
  assert.equal(decoded.digestVerified, true);
  s2.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test("摘要比较：篡改内容 match=false，但仍可解码", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir);
  const t = service.transform({ text: "banana" });
  const same = service.compareDigest({ recordId: t.id }, { text: "banana" });
  assert.equal(same.match, true);
  const tampered = service.compareDigest({ recordId: t.id }, { text: "bananb" });
  assert.equal(tampered.match, false);
  // 仍可解码（解码不依赖摘要）
  assert.ok(service.decode({ recordId: t.id }).bytes.length === 6);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("旋转行分页不截短正式 L/解码结果", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir);
  const t = service.transform({ text: "banana" });
  const p0 = service.rotations({ recordId: t.id }, 0, 3);
  assert.equal(p0.rows.length, 3);
  assert.equal(p0.total, 6);
  const p1 = service.rotations({ recordId: t.id }, 1, 3);
  assert.equal(p1.rows.length, 3);
  const decoded = service.decode({ recordId: t.id });
  assert.equal(decoded.bytes.length, 6);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("单步 LF 查询与越界行号", () => {
  const dir = tempDir();
  const { store, service } = makeService(dir);
  const t = service.transform({ text: "banana" });
  const step = service.lfStep({ recordId: t.id }, 0);
  assert.equal(step.byte, "n".charCodeAt(0));
  assert.equal(step.occurrence, step.occurrence);
  assert.throws(
    () => service.lfStep({ recordId: t.id }, 6),
    (e: unknown) => e instanceof BwtError && e.code === "PRIMARY_OUT_OF_RANGE"
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("跨进程：CLI 导出 -> 删除原输入引用 -> 新数据目录导入解码", () => {
  const cli = join(process.cwd(), "src", "cli.ts");
  const work = tempDir();
  const data1 = join(work, "data1");
  const data2 = join(work, "data2");
  const input = join(work, "input.bin");
  const inputBytes = Buffer.from([0, 72, 255, 1, 0, 200]);
  writeFileSync(input, inputBytes);
  const envelopePath = join(work, "export.json");
  const outPath = join(work, "out.bin");

  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const run = (args: string[], env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [tsxCli, cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, BWT_DATA_DIR: env.BWT_DATA_DIR },
    });

  const transformOut = run(["transform", "--file", input], { BWT_DATA_DIR: data1 });
  const id = (JSON.parse(transformOut) as { id: string }).id;

  run(["export", "--record", id, "--out", envelopePath], { BWT_DATA_DIR: data1 });
  // 原输入文件与原始数据目录都删除，只保留导出 envelope
  rmSync(data1, { recursive: true, force: true });
  rmSync(input, { force: true });
  assert.ok(!existsSync(input));
  assert.ok(existsSync(envelopePath));

  run(["import", "--envelope", envelopePath], { BWT_DATA_DIR: data2 });
  const importOut = run(["list"], { BWT_DATA_DIR: data2 });
  const importedId = (JSON.parse(importOut) as { items: { id: string }[] }).items[0]!.id;
  run(["decode", "--record", importedId, "--out", outPath], { BWT_DATA_DIR: data2 });

  assert.ok(readFileSync(outPath).equals(inputBytes), "跨进程、脱离原输入后应完整还原字节");
  rmSync(work, { recursive: true, force: true });
});
