import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { encodeBase64, tryDecodeUtf8 } from './core/bytes.js';
import { DEFAULT_MAX_BLOCK_BYTES } from './core/bwt.js';
import { sha256 } from './core/digest.js';
import { listBlocks, openDatabase } from './db.js';
import { AppError } from './errors.js';
import { BwtService, parsePositiveInteger } from './service.js';

export interface ServerConfig {
  port?: number;
  host?: string;
  dataDir?: string;
  maxBlockBytes?: number;
}

export interface RunningServer {
  server: Server;
  port: number;
  dataDir: string;
  close: () => Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(value, null, 2));
}

async function readRequestBuffer(request: IncomingMessage, maxBlockBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBlockBytes) {
      throw new AppError('BLOCK_TOO_LARGE', `请求体超过上限 ${maxBlockBytes} 字节。`, 413);
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new AppError('BLOCK_TOO_LARGE', 'JSON 请求体超过 1 MiB。', 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', '请求体不是合法 JSON。');
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_JSON', '请求 JSON 必须是对象。');
  }
  return value as Record<string, unknown>;
}

function matchPath(pathname: string, pattern: string): RegExpMatchArray | null {
  const regexText = pattern.replace(/:[A-Za-z]+/g, '([^/]+)');
  return new RegExp(`^${regexText}$`).exec(pathname);
}

export function createBwtServer(config: ServerConfig = {}): { server: Server; dataDir: string; closeStorage: () => void } {
  const maxBlockBytes = config.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
  const dataDir = config.dataDir ?? join(process.cwd(), 'data');
  const database = openDatabase(join(dataDir, 'bwt.sqlite'));
  const service = new BwtService(database, { defaultMaxBlockBytes: maxBlockBytes });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = request.method ?? 'GET';

      if (method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { ok: true, maxBlockBytes, dataDir });
        return;
      }

      if (method === 'POST' && pathname === '/v1/blocks/transform') {
        const contentType = request.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          const body = requireObject(await readJson(request));
          const format = body.format;
          if (format !== 'utf8' && format !== 'hex' && format !== 'base64') {
            throw new AppError('INVALID_ENCODING', 'format 必须是 utf8、hex 或 base64。');
          }
          const limit = service.readLimit(body.maxBlockBytes);
          const input = service.readTextInput(format, body.value, limit);
          const result = service.transform(input, limit);
          sendJson(response, 201, transformResponse(result));
        } else if (contentType.includes('application/octet-stream')) {
          const limit = service.readLimit(request.headers['x-max-block-bytes']);
          const bytes = await readRequestBuffer(request, limit);
          const result = service.transform({ bytes, format: 'file', sourceName: 'HTTP request body' }, limit);
          sendJson(response, 201, transformResponse(result));
        } else {
          throw new AppError('UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 或 application/octet-stream。', 415);
        }
        return;
      }

      if (method === 'GET' && pathname === '/v1/blocks') {
        const limit = parsePositiveInteger(url.searchParams.get('limit'), 'limit', 50, 200);
        const offset = parsePositiveInteger(url.searchParams.get('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, { blocks: listBlocks(database, limit, offset), limit, offset });
        return;
      }

      const blockMatch = matchPath(pathname, '/v1/blocks/:id');
      if (method === 'GET' && blockMatch) {
        const stored = service.getStored(decodeURIComponent(blockMatch[1]!));
        sendJson(response, 200, storedResponse(stored));
        return;
      }

      const rotationsMatch = matchPath(pathname, '/v1/blocks/:id/rotations');
      if (method === 'GET' && rotationsMatch) {
        const stored = service.getStored(decodeURIComponent(rotationsMatch[1]!));
        const limit = parsePositiveInteger(url.searchParams.get('limit'), 'limit', 64, 256);
        const offset = parsePositiveInteger(url.searchParams.get('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER);
        const result = service.getRotations(stored, { limit, offset });
        sendJson(response, 200, {
          total: result.total,
          limit,
          offset,
          rows: result.rows.map((row) => ({
            rank: row.rank,
            sourceOffset: row.offset,
            lastByte: row.lastByte,
            rotationBase64: encodeBase64(row.rotation),
            rotationUtf8: tryDecodeUtf8(row.rotation),
          })),
        });
        return;
      }

      const lfMatch = matchPath(pathname, '/v1/blocks/:id/lf');
      if (method === 'GET' && lfMatch) {
        const stored = service.getStored(decodeURIComponent(lfMatch[1]!));
        const row = parsePositiveInteger(url.searchParams.get('row'), 'row', 0, Number.MAX_SAFE_INTEGER);
        sendJson(response, 200, service.getLfStep(stored, row));
        return;
      }

      const inverseMatch = matchPath(pathname, '/v1/blocks/:id/inverse');
      if (method === 'POST' && inverseMatch) {
        const stored = service.getStored(decodeURIComponent(inverseMatch[1]!));
        const body = requireObject(await readJson(request));
        const outputBudget = service.readLimit(body.outputBudget ?? stored.maxBlockBytes);
        const result = service.inverseStored(stored, outputBudget);
        sendJson(response, 200, {
          length: result.bytes.length,
          base64: encodeBase64(result.bytes),
          utf8: tryDecodeUtf8(result.bytes),
          digest: { expectedSha256: result.expectedSha256, actualSha256: result.actualSha256, matches: result.digestMatches },
        });
        return;
      }

      const exportMatch = matchPath(pathname, '/v1/blocks/:id/export');
      if (method === 'GET' && exportMatch) {
        const stored = service.getStored(decodeURIComponent(exportMatch[1]!));
        const includeDigest = url.searchParams.get('digest') !== 'false';
        sendJson(response, 200, service.exportStored(stored, includeDigest));
        return;
      }

      const verifyMatch = matchPath(pathname, '/v1/blocks/:id/verify');
      if (method === 'POST' && verifyMatch) {
        const stored = service.getStored(decodeURIComponent(verifyMatch[1]!));
        const body = requireObject(await readJson(request));
        const outputBudget = service.readLimit(body.outputBudget ?? stored.maxBlockBytes);
        const expected = body.expectedSha256;
        if (expected !== undefined && typeof expected !== 'string') {
          throw new AppError('INVALID_INPUT', 'expectedSha256 必须是字符串。');
        }
        const result = service.inverseStored(stored, outputBudget);
        const target = typeof expected === 'string' ? expected : result.expectedSha256;
        sendJson(response, 200, { matches: result.actualSha256 === target, expectedSha256: target, actualSha256: result.actualSha256 });
        return;
      }

      if (method === 'POST' && pathname === '/v1/exports/import') {
        const contentType = request.headers['content-type'] ?? '';
        const limit = service.readLimit(request.headers['x-max-block-bytes']);
        if (contentType.includes('application/json')) {
          const parsed = await readJson(request);
          sendJson(response, 201, service.importExportJson(JSON.stringify(parsed), limit, 'HTTP JSON import'));
        } else if (contentType.includes('application/octet-stream')) {
          const bytes = await readRequestBuffer(request, limit + 4096);
          sendJson(response, 201, service.importExportJson(new TextDecoder().decode(bytes), limit, 'HTTP file import'));
        } else {
          throw new AppError('UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 或 application/octet-stream。', 415);
        }
        return;
      }

      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '路由不存在。' } });
    } catch (error) {
      if (error instanceof AppError) {
        sendJson(response, error.statusCode, { error: { code: error.code, message: error.message, details: error.details ?? null } });
      } else {
        const message = error instanceof Error ? error.message : '未知错误。';
        sendJson(response, 500, { error: { code: 'INTERNAL_ERROR', message } });
      }
    }
  });

  return {
    server,
    dataDir,
    closeStorage: () => database.close(),
  };
}

function transformResponse(result: ReturnType<BwtService['transform']>) {
  return {
    id: result.id,
    length: result.length,
    primary: result.primary,
    L: { base64: encodeBase64(result.L), hex: Buffer.from(result.L).toString('hex'), utf8: tryDecodeUtf8(result.L) },
    summary: { inputSha256: result.inputSha256, LSha256: result.LSha256 },
  };
}

function storedResponse(stored: Awaited<ReturnType<BwtService['getStored']>>) {
  return {
    id: stored.id,
    length: stored.length,
    primary: stored.primary,
    L: { base64: encodeBase64(stored.lBytes), hex: Buffer.from(stored.lBytes).toString('hex') },
    inputFormat: stored.inputFormat,
    sourceName: stored.sourceName,
    transformVersion: stored.transformVersion,
    summary: { inputSha256: stored.inputSha256, LSha256: sha256(stored.lBytes) },
    createdAt: stored.createdAt,
  };
}

export async function startBwtServer(config: ServerConfig = {}): Promise<RunningServer> {
  const created = createBwtServer(config);
  const port = config.port ?? 0;
  const host = config.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(port, host, () => resolve());
  });
  const address = created.server.address();
  if (!address || typeof address === 'string') throw new AppError('INTERNAL_ERROR', '无法确定监听端口。', 500);
  return {
    server: created.server,
    port: address.port,
    dataDir: created.dataDir,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        created.server.close((error) => (error ? reject(error) : resolve()));
      });
      created.closeStorage();
    },
  };
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const config: ServerConfig = {};
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.HOST) config.host = process.env.HOST;
  if (process.env.BWT_DATA_DIR) config.dataDir = process.env.BWT_DATA_DIR;
  if (process.env.BWT_MAX_BYTES && Number.isSafeInteger(Number(process.env.BWT_MAX_BYTES))) {
    config.maxBlockBytes = Number(process.env.BWT_MAX_BYTES);
  }
  startBwtServer(config).then((running) => {
    console.log(`BWT 服务已启动: http://${process.env.HOST ?? '127.0.0.1'}:${running.port}`);
    console.log(`数据目录: ${running.dataDir}`);
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
