#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeBase64, decodeHex, encodeBase64, renderBytes, tryDecodeUtf8 } from './core/bytes.js';
import {
  bwt,
  buildRotationRows,
  DEFAULT_MAX_BLOCK_BYTES,
  inverseBwt,
  lfStep,
  rebuildBySortedTable,
} from './core/bwt.js';
import { sha256 } from './core/digest.js';
import { makeExport, parseExport, verifyOriginalDigest } from './core/export.js';
import { openDatabase } from './db.js';
import { AppError } from './errors.js';
import { BwtService } from './service.js';
import { startBwtServer } from './server.js';

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      if (equalIndex >= 0) {
        options.set(arg.slice(2, equalIndex), arg.slice(equalIndex + 1));
      } else if (['input', 'file', 'output', 'format', 'export', 'max', 'budget', 'limit', 'offset', 'row', 'primary', 'coding', 'port', 'host', 'data-dir', 'digest', 'L'].includes(arg.slice(2))) {
        options.set(arg.slice(2), argv[index + 1] ?? '');
        index += 1;
      } else {
        flags.add(arg.slice(2));
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options, flags };
}

function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name);
}

function numberOption(args: ParsedArgs, name: string, fallback: number): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError('INVALID_INPUT', `--${name} 必须是非负安全整数。`);
  return value;
}

async function loadInput(args: ParsedArgs, max: number): Promise<Uint8Array> {
  const filePath = option(args, 'file');
  if (filePath !== undefined) {
    const bytes = new Uint8Array(await readFile(filePath));
    if (bytes.length > max) throw new AppError('BLOCK_TOO_LARGE', `文件块长度 ${bytes.length} 超过上限 ${max} 字节。`, 413);
    return bytes;
  }
  const format = option(args, 'format') ?? 'utf8';
  const input = option(args, 'input');
  if (input === undefined) throw new AppError('INVALID_INPUT', '请提供 --file <path> 或 --input <value>。');
  let bytes: Uint8Array;
  if (format === 'utf8') bytes = new TextEncoder().encode(input);
  else if (format === 'hex') bytes = decodeHex(input);
  else if (format === 'base64') bytes = decodeBase64(input);
  else throw new AppError('INVALID_ENCODING', '输入 format 仅支持 utf8、hex、base64。');
  if (bytes.length > max) throw new AppError('BLOCK_TOO_LARGE', `块长度 ${bytes.length} 超过上限 ${max} 字节。`, 413);
  return bytes;
}

async function writeOutput(bytes: Uint8Array, args: ParsedArgs): Promise<void> {
  const outputPath = option(args, 'output');
  const coding = option(args, 'coding') ?? 'utf8';
  if (outputPath !== undefined) {
    if (args.flags.has('force')) await writeFile(outputPath, bytes);
    else await writeFile(outputPath, bytes, { flag: 'wx' });
    console.log(`已写入 ${bytes.length} 字节: ${resolve(outputPath)}`);
    return;
  }
  if (coding === 'hex') console.log(Buffer.from(bytes).toString('hex'));
  else if (coding === 'base64') console.log(encodeBase64(bytes));
  else {
    const decoded = tryDecodeUtf8(bytes);
    console.log(decoded.ok ? decoded.text : renderBytes(bytes));
    if (!decoded.ok) console.error('[提示] UTF-8 解码失败；上面是无损的 \\xNN 显示，文件输出仍为完整二进制。');
  }
}

async function openService(args: ParsedArgs) {
  const dataDir = resolve(option(args, 'data-dir') ?? join(process.cwd(), 'data'));
  const max = numberOption(args, 'max', DEFAULT_MAX_BLOCK_BYTES);
  const database = openDatabase(join(dataDir, 'bwt.sqlite'));
  return { service: new BwtService(database, { defaultMaxBlockBytes: max }), dataDir, max, database };
}

async function commandTransform(args: ParsedArgs): Promise<void> {
  const context = await openService(args);
  const filePath = option(args, 'file');
  const input = filePath !== undefined
    ? await context.service.readInputFile(filePath, context.max)
    : context.service.readTextInput(
        (option(args, 'format') ?? 'utf8') as 'utf8' | 'hex' | 'base64',
        option(args, 'input'),
        context.max,
      );
  const result = context.service.transform(input, context.max);
  console.log(JSON.stringify({
    id: result.id,
    length: result.length,
    primary: result.primary,
    L: {
      hex: Buffer.from(result.L).toString('hex'),
      base64: encodeBase64(result.L),
      utf8: tryDecodeUtf8(result.L),
    },
    inputSha256: result.inputSha256,
    LSha256: result.LSha256,
  }, null, 2));
}

async function commandCoreTransform(args: ParsedArgs): Promise<void> {
  const max = numberOption(args, 'max', DEFAULT_MAX_BLOCK_BYTES);
  const input = await loadInput(args, max);
  const result = bwt(input, max);
  await writeOutput(result.L, args);
  console.error(`length=${result.length} primary=${result.primary}`);
}

async function commandInverse(args: ParsedArgs): Promise<void> {
  const max = numberOption(args, 'budget', numberOption(args, 'max', DEFAULT_MAX_BLOCK_BYTES));
  const exportPath = option(args, 'export');
  let bytes: Uint8Array;
  let expectedSha256: string | undefined;
  if (exportPath !== undefined) {
    const parsed = parseExport(JSON.parse(await readFile(exportPath, 'utf8')), max);
    bytes = inverseBwt(parsed.L, parsed.primary, { outputBudget: max });
    expectedSha256 = parsed.originalSha256;
  } else if (option(args, 'L') !== undefined || args.options.has('L')) {
    const coding = option(args, 'coding') ?? 'hex';
    const L = coding === 'hex' ? decodeHex(args.options.get('L')!) : decodeBase64(args.options.get('L')!);
    const primary = numberOption(args, 'primary', 0);
    bytes = inverseBwt(L, primary, { outputBudget: max });
  } else {
    const context = await openService(args);
    const id = args.positional[1];
    if (!id) throw new AppError('INVALID_INPUT', '请提供块 id。');
    const stored = context.service.getStored(id);
    const result = await context.service.writeInverseOutput(stored, requiredOutput(args), max, args.flags.has('force'));
    bytes = result.bytes;
    console.error(`digestMatches=${result.digestMatches} sha256=${result.actualSha256}`);
    return;
  }
  await writeOutput(bytes, args);
  if (expectedSha256) console.error(`digestMatches=${verifyOriginalDigest(bytes, expectedSha256)}`);
}

function requiredOutput(args: ParsedArgs): string {
  const output = option(args, 'output');
  if (!output) throw new AppError('INVALID_INPUT', '数据库逆变换必须指定 --output <new-file>，原文件不会被修改。');
  return resolve(output);
}

async function commandRotations(args: ParsedArgs): Promise<void> {
  const context = await openService(args);
  const id = args.positional[1];
  if (!id) throw new AppError('INVALID_INPUT', '请提供块 id。');
  const limit = numberOption(args, 'limit', 64);
  const offset = numberOption(args, 'offset', 0);
  const result = context.service.getRotations(context.service.getStored(id), { limit, offset });
  console.log(JSON.stringify({
    total: result.total,
    limit,
    offset,
    rows: result.rows.map((row) => ({
      rank: row.rank,
      sourceOffset: row.offset,
      lastByte: row.lastByte,
      text: renderBytes(row.rotation),
      hex: Buffer.from(row.rotation).toString('hex'),
    })),
  }, null, 2));
}

async function commandLf(args: ParsedArgs): Promise<void> {
  const context = await openService(args);
  const id = args.positional[1];
  const row = numberOption(args, 'row', 0);
  if (!id) throw new AppError('INVALID_INPUT', '请提供块 id。');
  console.log(JSON.stringify(context.service.getLfStep(context.service.getStored(id), row), null, 2));
}

async function commandExport(args: ParsedArgs): Promise<void> {
  const context = await openService(args);
  const id = args.positional[1];
  if (!id) throw new AppError('INVALID_INPUT', '请提供块 id。');
  const document = context.service.exportStored(context.service.getStored(id), !args.flags.has('no-digest'));
  const output = option(args, 'output');
  const text = JSON.stringify(document, null, 2);
  if (output) await writeFile(output, text, { flag: args.flags.has('force') ? 'w' : 'wx' });
  else console.log(text);
}

async function commandImportExport(args: ParsedArgs): Promise<void> {
  const context = await openService(args);
  const path = option(args, 'export') ?? args.positional[1];
  if (!path) throw new AppError('INVALID_INPUT', '请提供导出文件路径。');
  console.log(JSON.stringify(await context.service.importExportFile(path, context.max), null, 2));
}

async function commandDigest(args: ParsedArgs): Promise<void> {
  const max = numberOption(args, 'max', DEFAULT_MAX_BLOCK_BYTES);
  const bytes = await loadInput(args, max);
  const actual = sha256(bytes);
  const expected = option(args, 'digest');
  console.log(JSON.stringify({ sha256: actual, matches: expected === undefined ? null : actual === expected }, null, 2));
  if (expected !== undefined && actual !== expected) throw new AppError('DIGEST_MISMATCH', '摘要不匹配。', 409);
}

async function commandServe(args: ParsedArgs): Promise<void> {
  const config: Parameters<typeof startBwtServer>[0] = {
    dataDir: resolve(option(args, 'data-dir') ?? join(process.cwd(), 'data')),
    maxBlockBytes: numberOption(args, 'max', DEFAULT_MAX_BLOCK_BYTES),
  };
  if (args.options.has('port')) config.port = numberOption(args, 'port', 0);
  const host = option(args, 'host');
  if (host !== undefined) config.host = host;
  const running = await startBwtServer(config);
  console.log(`BWT 服务已启动: http://127.0.0.1:${running.port}`);
  console.log('按 Ctrl+C 停止。');
}

async function commandDemo(): Promise<void> {
  const input = new TextEncoder().encode('banana');
  const result = bwt(input);
  const rows = buildRotationRows(input);
  const restored = inverseBwt(result.L, result.primary);
  const alternate = rebuildBySortedTable(result.L, result.primary);
  console.log('输入: banana');
  console.log(`L(UTF-8): ${new TextDecoder().decode(result.L)}  (要求 nnbaaa)`);
  console.log(`primary: ${result.primary}  (要求 3)`);
  console.log(`还原: ${new TextDecoder().decode(restored)}`);
  console.log(`逐轮表重建一致: ${Buffer.compare(alternate, restored) === 0}`);
  console.log('排序旋转表:');
  for (const row of rows) {
    console.log(`${row.rank}: ${new TextDecoder().decode(row.rotation)} [sourceOffset=${row.offset}, last=${String.fromCharCode(row.lastByte)}]`);
  }
  console.log('\nLF 步骤:');
  let row = result.primary;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const step = lfStep(result.L, row);
    console.log(`还原位置 ${index}: row=${step.row}, byte='${String.fromCharCode(step.byte)}', occurrence=${step.occurrence}, nextRow=${step.nextRow}`);
    row = step.nextRow;
  }
}

function printHelp(): void {
  console.log(`byte-bwt - 本地字节块 BWT/LF 后端

命令:
  transform  正变换并写入 SQLite（--input/--file, --format utf8|hex|base64）
  transform-core 不写库的核心正变换
  inverse <id> --output new.bin  数据库产物逆变换到新文件
  inverse --L <hex|base64> --primary n --coding hex|base64
  inverse --export doc.json --output restored.bin
  rotations <id> [--limit 64] [--offset 0]
  lf <id> --row n
  export <id> [--output doc.json] [--no-digest] [--force]
  import --export doc.json
  digest --input ... 或 --file path [--digest sha256]
  serve [--port 0] [--data-dir ./data] [--max 4096]
  demo

环境变量: PORT, HOST, BWT_DATA_DIR, BWT_MAX_BYTES
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  switch (command) {
    case 'transform': await commandTransform(args); break;
    case 'transform-core': await commandCoreTransform(args); break;
    case 'inverse': await commandInverse(args); break;
    case 'rotations': await commandRotations(args); break;
    case 'lf': await commandLf(args); break;
    case 'export': await commandExport(args); break;
    case 'import': await commandImportExport(args); break;
    case 'digest': await commandDigest(args); break;
    case 'serve': await commandServe(args); break;
    case 'demo': await commandDemo(); break;
    case undefined:
    case 'help':
    case '--help':
    case '-h': printHelp(); break;
    default: throw new AppError('NOT_FOUND', `未知命令：${command}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(`错误 [${error.code}] ${error.message}`);
    if (error.details !== undefined) console.error(error.details);
  } else if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
    console.error('错误 [FILE_WRITE_ERROR] 输出文件已存在；如需覆盖请加 --force。');
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
