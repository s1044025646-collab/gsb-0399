import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { BwtService } from "./service.js";
import { BwtError, ERROR_STATUS } from "./errors.js";
import { encodeBytes } from "./codec.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new BwtError("BLOCK_TOO_LARGE", `请求体超过 ${maxBytes} 字节上限`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BwtError("BAD_REQUEST", "请求体不是合法 JSON");
  }
}

/**
 * 路由：
 *  POST /transform            正变换（body: {encoding,data|text, lEncoding, withDigest}）
 *  GET  /records             列表（?limit&offset）
 *  GET  /records/:id         查看记录
 *  POST /records/:id/rotations 或 /rotations  分页旋转行（body 可带 block/envelope）
 *  POST /lf                  单步 LF（{recordId|envelope,row}）
 *  POST /decode              独立逆变换（{recordId|envelope,outputEncoding,outputBudget}）
 *  POST /export              导出 envelope
 *  POST /compare             比较摘要（{recordId|envelope, encoding,data|text}）
 */
export function createApiServer(service: BwtService): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true });
      }

      if (method === "POST" && path === "/transform") {
        const body = await readJson(req, service.maxLimitBytes);
        const outcome = service.transform(body, {
          lEncoding: body.lEncoding === "hex" ? "hex" : "base64",
          withDigest: body.withDigest,
        });
        return send(res, 200, outcome);
      }

      if (method === "GET" && path === "/records") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
        const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
        return send(res, 200, service.list(limit, offset));
      }

      const recordMatch = path.match(/^\/records\/([^/]+)$/);
      if (method === "GET" && recordMatch) {
        return send(res, 200, service.getRecordOrThrow(decodeURIComponent(recordMatch[1]!)));
      }

      const rotationsMatch = path.match(/^\/records\/([^/]+)\/rotations$/);
      if (method === "POST" && (path === "/rotations" || rotationsMatch)) {
        const body = await readJson(req, service.maxLimitBytes);
        const page = Number(body.page ?? 0);
        const pageSize = Math.min(Number(body.pageSize ?? 64) || 64, 512);
        const source = rotationsMatch
          ? { recordId: decodeURIComponent(rotationsMatch[1]!) }
          : { recordId: body.recordId, envelope: body.envelope, block: body.block };
        return send(res, 200, service.rotations(source, page, pageSize));
      }

      if (method === "POST" && path === "/lf") {
        const body = await readJson(req, service.maxLimitBytes);
        const row = Number(body.row);
        return send(res, 200, service.lfStep({ recordId: body.recordId, envelope: body.envelope }, row));
      }

      if (method === "POST" && path === "/decode") {
        const body = await readJson(req, service.maxLimitBytes);
        const decoded = service.decode(
          { recordId: body.recordId, envelope: body.envelope },
          { outputBudget: body.outputBudget }
        );
        const encoding = body.outputEncoding === "hex" ? "hex" : "base64";
        return send(res, 200, {
          n: decoded.n,
          primary: decoded.primary,
          outputEncoding: encoding,
          bytes: encodeBytes(decoded.bytes, encoding),
          utf8: encoding === "base64" && body.includeUtf8 === true
            ? Buffer.from(decoded.bytes).toString("utf8")
            : undefined,
          digest: decoded.digest,
          digestVerified: decoded.digestVerified,
        });
      }

      if (method === "POST" && path === "/export") {
        const body = await readJson(req, service.maxLimitBytes);
        return send(res, 200, service.exportEnvelope({ recordId: body.recordId, envelope: body.envelope }));
      }

      if (method === "POST" && path === "/compare") {
        const body = await readJson(req, service.maxLimitBytes);
        return send(
          res,
          200,
          service.compareDigest(
            { recordId: body.recordId, envelope: body.envelope },
            { encoding: body.encoding, data: body.data, text: body.text }
          )
        );
      }

      return send(res, 404, { error: { code: "BAD_REQUEST", message: `无此路由 ${method} ${path}` } });
    } catch (err) {
      if (err instanceof BwtError) {
        return send(res, ERROR_STATUS[err.code], { error: { code: err.code, message: err.message, details: err.details } });
      }
      return send(res, 500, {
        error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
}

/** 请求体上限：base64 膨胀约 4/3，再加 JSON 包装余量。 */

/** 在端口 0 上监听，由操作系统分配空闲端口；也可用 preferredPort 指定。 */
export function listen(server: Server, preferredPort?: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}
