#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { BwtStore } from "./db.js";
import { BwtService } from "./service.js";
import { createApiServer, listen } from "./api.js";
import { parseEnvelope } from "./codec.js";
import {
  bwtForward,
  bwtInverse,
  buildLfTables,
  rotationTable,
  bwtInverseByReconstruction,
  DEFAULT_MAX_BLOCK,
} from "./bwt.js";
import { BwtError } from "./errors.js";

interface Args {
  flags: Map<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function flag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
}

const DATA_DIR = resolve(process.env.BWT_DATA_DIR ?? join(process.cwd(), "data"));

function makeContext(args: Args): { store: BwtStore; service: BwtService; dataDir: string } {
  mkdirSync(DATA_DIR, { recursive: true });
  const maxBlock = Number(flag(args.flags, "max-block") ?? DEFAULT_MAX_BLOCK);
  const dbPath = flag(args.flags, "db") ?? join(DATA_DIR, "bwt.sqlite");
  const store = new BwtStore(dbPath);
  return { store, service: new BwtService(store, maxBlock), dataDir: DATA_DIR };
}

function blockPayload(args: Args): { encoding: string; data?: string; text?: string } {
  const file = flag(args.flags, "file");
  const hex = flag(args.flags, "hex");
  const text = flag(args.flags, "text");
  if (file) {
    return { encoding: "base64", data: readFileSync(file).toString("base64") };
  }
  if (hex !== undefined) return { encoding: "hex", data: hex };
  if (text !== undefined) return { encoding: "utf8", text };
  throw new BwtError("BAD_REQUEST", "需要 --file <路径> / --hex <十六进制> / --text <UTF-8文本> 之一");
}

function source(args: Args): { recordId?: string; envelope?: unknown } {
  const record = flag(args.flags, "record");
  const envelopePath = flag(args.flags, "envelope");
  if (record) return { recordId: record };
  if (envelopePath) return { envelope: JSON.parse(readFileSync(envelopePath, "utf8")) };
  throw new BwtError("BAD_REQUEST", "需要 --record <id> 或 --envelope <导出文件>");
}

function bytesToDisplay(bytes: Uint8Array): { hex: string; utf8: string | null } {
  const hex = Buffer.from(bytes).toString("hex");
  let utf8: string | null = null;
  try {
    const decoded = Buffer.from(bytes).toString("utf8");
    if (Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) utf8 = decoded;
  } catch {
    utf8 = null;
  }
  return { hex, utf8 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0] ?? "help";

  if (command === "help" || args.flags.has("help")) {
    printHelp();
    return;
  }

  if (command === "demo") {
    runDemo();
    return;
  }

  const ctx = makeContext(args);
  try {
    switch (command) {
      case "serve":
        await runServe(ctx.service, args);
        return;
      case "transform":
        cmdTransform(ctx.service, args);
        break;
      case "rotations":
        cmdRotations(ctx.service, args);
        break;
      case "lf":
        cmdLf(ctx.service, args);
        break;
      case "decode":
        cmdDecode(ctx.service, args);
        break;
      case "export":
        cmdExport(ctx.service, args);
        break;
      case "import":
        cmdImport(ctx.service, args);
        break;
      case "compare":
        cmdCompare(ctx.service, args);
        break;
      case "list":
        console.log(JSON.stringify(ctx.service.list(Number(flag(args.flags, "limit") ?? 50), 0), null, 2));
        break;
      default:
        throw new BwtError("BAD_REQUEST", `未知命令 ${command}，运行 bwt help 查看用法`);
    }
  } finally {
    ctx.store.close();
  }
}

function printHelp(): void {
  console.log(`BWT 字节块变换后端（TypeScript + Node.js + SQLite）

用法:
  bwt serve [--port 0] [--max-block 8192] [--db path]   启动 HTTP API（默认 0=系统分配空闲端口）
  bwt transform (--file f | --hex h | --text t) [--l-encoding hex|base64] [--no-digest]
  bwt rotations (--record id | --envelope f | 同 transform 的输入) [--page 0] [--page-size 64]
  bwt lf (--record id | --envelope f) --row N           查询单个 LF 步骤
  bwt decode (--record id | --envelope f) --out f [--output-budget N]
  bwt export (--record id | --envelope f) [--out f]     输出版本化导出结构
  bwt import --envelope f                               导入旧产物并入库（不依赖原输入）
  bwt compare (--record id | --envelope f) (--file|--hex|--text)
  bwt list
  bwt demo                                              banana / abab / 含零字节 往返演示

数据目录默认 ./data，可用环境变量 BWT_DATA_DIR 覆盖。`);
}

async function runServe(service: BwtService, args: Args): Promise<void> {
  const port = Number(flag(args.flags, "port") ?? process.env.PORT ?? 0);
  const server = createApiServer(service);
  const bound = await listen(server, port);
  console.log(JSON.stringify({ status: "listening", baseUrl: `http://127.0.0.1:${bound.port}`, maxBlock: service.maxBlock }));
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      bound.close();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

function cmdTransform(service: BwtService, args: Args): void {
  const outcome = service.transform(blockPayload(args), {
    lEncoding: flag(args.flags, "l-encoding") === "hex" ? "hex" : "base64",
    withDigest: !args.flags.has("no-digest"),
  });
  console.log(JSON.stringify(outcome, null, 2));
}

function cmdRotations(service: BwtService, args: Args): void {
  const page = Number(flag(args.flags, "page") ?? 0);
  const pageSize = Number(flag(args.flags, "page-size") ?? 64);
  const hasBlockInput = args.flags.has("file") || args.flags.has("hex") || args.flags.has("text");
  const src = hasBlockInput ? { block: blockPayload(args) } : source(args);
  console.log(JSON.stringify(service.rotations(src, page, pageSize), null, 2));
}

function cmdLf(service: BwtService, args: Args): void {
  const row = Number(flag(args.flags, "row"));
  if (!Number.isInteger(row)) throw new BwtError("BAD_REQUEST", "--row 必须是整数行号");
  console.log(JSON.stringify(service.lfStep(source(args), row), null, 2));
}

function cmdDecode(service: BwtService, args: Args): void {
  const out = flag(args.flags, "out");
  const decoded = service.decode(source(args), { outputBudget: Number(flag(args.flags, "output-budget") ?? undefined) });
  if (out) {
    // 完整字节写入新文件；原文件不修改。UTF-8 失败不影响二进制正确性。
    writeFileSync(out, Buffer.from(decoded.bytes));
    console.log(JSON.stringify({ written: out, n: decoded.n, digestVerified: decoded.digestVerified }, null, 2));
  } else {
    const display = bytesToDisplay(decoded.bytes);
    console.log(JSON.stringify({ n: decoded.n, hex: display.hex, utf8: display.utf8, digestVerified: decoded.digestVerified }, null, 2));
  }
}

function cmdExport(service: BwtService, args: Args): void {
  const envelope = service.exportEnvelope(source(args));
  const out = flag(args.flags, "out");
  const text = JSON.stringify(envelope, null, 2);
  if (out) writeFileSync(out, text + "\n", "utf8");
  console.log(text);
}

function cmdImport(service: BwtService, args: Args): void {
  const envelopePath = flag(args.flags, "envelope");
  if (!envelopePath) throw new BwtError("BAD_REQUEST", "导入需要 --envelope <文件>");
  const parsed = parseEnvelope(JSON.parse(readFileSync(envelopePath, "utf8")), service.maxBlock);
  const id = `imp-${(parsed.originalDigest ?? "").slice(0, 12) || `${parsed.n}-${parsed.primary}`}`;
  service["store"].insert({
    id,
    n: parsed.n,
    primary: parsed.primary,
    l_encoding: "base64",
    l_data: Buffer.from(parsed.L).toString("base64"),
    input_sha256: parsed.originalDigest ?? null,
    source_encoding: "imported",
    max_block: service.maxBlock,
  });
  console.log(JSON.stringify({ imported: true, id, n: parsed.n, primary: parsed.primary }, null, 2));
}

function cmdCompare(service: BwtService, args: Args): void {
  console.log(JSON.stringify(service.compareDigest(source(args), blockPayload(args)), null, 2));
}

function runDemo(): void {
  const cases: { name: string; bytes: Uint8Array }[] = [
    { name: "ASCII banana", bytes: new TextEncoder().encode("banana") },
    { name: "周期串 abab", bytes: new TextEncoder().encode("abab") },
    { name: "全相同 aaaa", bytes: new TextEncoder().encode("aaaa") },
    { name: "含零字节二进制", bytes: Uint8Array.from([0, 65, 0, 66, 255, 0]) },
    { name: "空块", bytes: new Uint8Array(0) },
    { name: "单字节 Z", bytes: new TextEncoder().encode("Z") },
  ];
  for (const c of cases) {
    const fwd = bwtForward(c.bytes);
    const back = bwtInverse(fwd.L, fwd.primary);
    const rebuilt = bwtInverseByReconstruction(fwd.L, fwd.primary);
    const ok = Buffer.from(back).equals(Buffer.from(c.bytes)) &&
      Buffer.from(rebuilt).equals(Buffer.from(c.bytes));
    console.log(`\n[${c.name}]  n=${c.bytes.length}`);
    console.log(`  原文 hex : ${Buffer.from(c.bytes).toString("hex") || "(空)"}`);
    console.log(`  L  (hex) : ${Buffer.from(fwd.L).toString("hex") || "(空)"}`);
    console.log(`  L(ascii) : ${c.bytes.length > 0 && c.bytes.every((b) => b >= 32 && b < 127) || c.name.includes("banana") ? Buffer.from(fwd.L).toString("latin1") : "-"}`);
    console.log(`  primary  : ${fwd.primary}`);
    console.log(`  还原 hex : ${Buffer.from(back).toString("hex") || "(空)"}`);
    console.log(`  两种逆变换一致: ${ok ? "OK" : "FAIL"}`);
  }

  const banana = new TextEncoder().encode("banana");
  const f = bwtForward(banana);
  console.log("\nbanana 排序旋转表（* = 原始行）:");
  for (const row of rotationTable(banana, f.sa)) {
    console.log(
      `  ${String(row.row).padStart(2)}  ${Buffer.from(row.rotation).toString("latin1")}${row.isPrimary ? "  *" : ""}`
    );
  }
  const tables = buildLfTables(f.L);
  console.log(`\nbanana L=${Buffer.from(f.L).toString("latin1")} primary=${f.primary}`);
  console.log("从 primary 沿 LF 回填演示（每步：row -> 字节 L[row] -> LF(row)）:");
  let row = f.primary;
  const collected: number[] = [];
  for (let pos = f.n - 1; pos >= 0; pos--) {
    const step = { pos, row, byte: f.L[row], next: tables.lf[row] };
    console.log(`  回填位置 ${pos}: row=${step.row}, 字节=${String.fromCharCode(step.byte as number)}, 下一 row=${step.next}`);
    collected[step.pos] = step.byte as number;
    row = step.next as number;
  }
  console.log(`  拼接结果: ${Buffer.from(collected).toString("latin1")}`);
}

main().catch((err: unknown) => {
  if (err instanceof BwtError) {
    console.error(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }));
  } else {
    console.error(err);
  }
  process.exit(1);
});
