# 本地字节块 BWT 与 LF 逆向还原后端

这是一个只包含 API 与 CLI 的 Windows 本地后端，用 TypeScript、Node.js 和 Node 内置 SQLite（`node:sqlite`）实现。核心始终处理 `0..255` 的字节，支持文件、十六进制、Base64 和 UTF-8 文本输入；UTF-8 只是输入/显示编码，不参与排序语义。

> 需要 Node.js 22.5 或更新版本（推荐使用当前 LTS/较新版本）。不使用 Docker、WSL、付费服务或外部在线 API。

## 重要边界

- BWT 是**可逆重排**，不是压缩；本项目不接入 Huffman、游程编码或其他压缩阶段。
- 默认块上限为 4096 字节，不承诺大文件或流式处理。
- 正变换使用清晰的循环移位直接比较，时间复杂度约为 `O(n² log n)`；正式逆变换用身份保持的稳定排序排列，时间复杂度约为 `O(n² log n)`、额外内存 `O(n)`。测试中的逐轮显式表重建是独立核对法，最坏内存约为 `O(n²)`，不属于正式解码输入。
- 不使用哨兵。若两个循环移位内容完全相同，按原始起点偏移升序打破平局。
- SQLite 保存输入 SHA-256、参数、变换版本、`primary` 和 `L`，不保存原块；导出文件可脱离数据库和原输入单独解码。
- 普通解码不提供篡改检测；只有导出或数据库中带 SHA-256 摘要时才单独报告 `digestMatches`。“能解码”不等于来源认证。

## Banana 示例

输入 `banana` 的循环移位按字节字典序排序：

| 排序行 | 内容 | 原始偏移 | 末列 L |
|---:|---|---:|---:|
| 0 | `abanan` | 5 | n |
| 1 | `anaban` | 3 | n |
| 2 | `ananab` | 1 | b |
| 3 | `banana` | 0 | a |
| 4 | `nabana` | 4 | a |
| 5 | `nanaba` | 2 | a |

因此 `L = nnbaaa`，原始未旋转行的零基编号 `primary = 3`。

LF 单步使用零基出现次数：

```text
LF(row) = C[L[row]] + Occ(row, L[row])
```

其中 `C[b]` 是首列中字节值严格小于 `b` 的行数，`Occ(row,b)` 是 `L[0..row-1]` 中 `b` 的次数。从 `primary=3` 开始，取当前行的 `L` 字节，然后从答案尾部向位置 0 回填；查询解释时保持排序过程中的行身份，以处理无哨兵周期串的相同旋转。

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
```

启动 HTTP 服务：

```powershell
npm start
# 或指定参数
$env:PORT="3000"; $env:BWT_MAX_BYTES="4096"; npm start
```

默认 `PORT=0`，由操作系统选择空闲端口；默认监听 `127.0.0.1`，数据目录为项目内 `./data`，数据库文件是 `./data/bwt.sqlite`。

## CLI 示例

正变换并写入 SQLite：

```powershell
node dist/cli.js transform --input banana --format utf8
node dist/cli.js transform --file input.bin
node dist/cli.js transform --input 00ff00 --format hex
```

不写库的核心正变换：

```powershell
node dist/cli.js transform-core --input banana --format utf8 --coding utf8
node dist/cli.js transform-core --file input.bin --coding base64
```

查看旋转分页和单步 LF：

```powershell
node dist/cli.js rotations <id> --limit 20 --offset 0
node dist/cli.js lf <id> --row 3
```

数据库逆变换到**新文件**，不修改原文件：

```powershell
node dist/cli.js inverse <id> --output restored.bin
```

仅使用 `L` 与 `primary`：

```powershell
node dist/cli.js inverse --L 6e6e62616161 --primary 3 --coding hex --output restored.bin
```

导出与独立导入/解码：

```powershell
node dist/cli.js export <id> --output banana.bwt.json
node dist/cli.js import --export banana.bwt.json
node dist/cli.js inverse --export banana.bwt.json --output restored.bin
node dist/cli.js digest --file restored.bin --digest <sha256>
```

二进制结果应优先使用 `--output`。若直接在终端显示且 UTF-8 解码失败，CLI 会给出 `\xNN` 形式的可读提示，但文件输出始终保留完整正确字节。

## HTTP API

所有错误返回：

```json
{ "error": { "code": "ERROR_CODE", "message": "中文错误信息", "details": null } }
```

常用接口：

- `GET /health`：健康检查、当前块上限和数据目录。
- `POST /v1/blocks/transform`：`application/json` 传 `{ "format": "utf8|hex|base64", "value": "..." }`，或直接发送 `application/octet-stream`。
- `GET /v1/blocks?limit=50&offset=0`：列出摘要。
- `GET /v1/blocks/:id`：查看版本、参数、`L`（Base64/Hex）和摘要。
- `GET /v1/blocks/:id/rotations?limit=64&offset=0`：分页查看旋转行；分页不截短正式 `L`。
- `GET /v1/blocks/:id/lf?row=3`：查询一个 LF 步骤。
- `POST /v1/blocks/:id/inverse`：JSON 可传 `{ "outputBudget": 4096 }`，返回 Base64 与摘要校验结果。
- `GET /v1/blocks/:id/export?digest=true`：版本化导出。
- `POST /v1/exports/import`：导入旧产物 JSON，不依赖原输入文件或原数据库。
- `POST /v1/blocks/:id/verify`：独立比较还原字节与给定 SHA-256。

PowerShell 调用示例：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/v1/blocks/transform -Method Post `
  -ContentType 'application/json' `
  -Body '{"format":"utf8","value":"banana"}'
```

## 导出结构

```json
{
  "format": "byte-bwt-export",
  "exportVersion": 1,
  "transformVersion": "BWT-BYTE/1",
  "block": {
    "length": 6,
    "primary": 3,
    "LCoding": "base64",
    "L": "bm5iYWFh"
  },
  "summary": {
    "originalSha256": "...",
    "LSha256": "..."
  },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

`LCoding` 支持 `base64` 与 `hex`。导入时校验版本、长度、Base64/Hex 合法性、`primary` 范围与输出预算；长度不一致或行号越界会拒绝。

## 结果大小

BWT 不缩短数据：核心 `L` 与输入块同为 `n` 字节，另需一个整数 `primary`。JSON Base64 会因编码与字段元数据变大，SQLite 还会保存索引和摘要。

## 错误码

- `INVALID_INPUT`、`INVALID_HEX`、`INVALID_BASE64`、`INVALID_ENCODING`
- `LENGTH_MISMATCH`、`INVALID_PRIMARY`
- `BLOCK_TOO_LARGE`、`OUTPUT_BUDGET_EXCEEDED`
- `NOT_FOUND`、`INVALID_JSON`、`INVALID_PAGINATION`、`UNSUPPORTED_MEDIA_TYPE`
- `FILE_READ_ERROR`、`FILE_WRITE_ERROR`
- `INVALID_EXPORT`、`DIGEST_MISMATCH`
- `INTERNAL_ERROR`

## 测试范围

`npm test` 覆盖：

- 空块、单字节、全部 256 种字节值和含零二进制。
- `banana` 的 `L=nnbaaa`、`primary=3` 与 LF 逐步还原。
- 周期串 `abab`、全相同字节的重复旋转平局。
- 显式排序旋转表核对正变换。
- 独立的逐轮表重建法核对 LF 逆变换。
- 长度不符、非法编码、越界 `primary`、输出预算。
- 跨 CLI 进程、全新数据目录、删除原输入文件后基于导出文件还原。
- HTTP API 正变换、导出、独立导入和错误行号。
