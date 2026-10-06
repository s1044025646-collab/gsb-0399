# BWT 字节块变换与 LF 逆向还原后端

纯本地运行的字节块 **Burrows–Wheeler Transform（BWT）** 可逆重排服务，提供 HTTP API 与命令行（CLI）。
使用 **TypeScript + Node.js + SQLite**，SQLite 采用 Node 内置的 `node:sqlite`，**无需编译原生模块、无需 Docker / WSL、无需任何在线服务**。

> **重要：BWT 只是可逆重排，不是压缩。**
> BWT 输出 `L` 的长度与输入完全相同（另加一个行号 `primary` 与少量元数据），产物体积通常**等于或略大于**输入。
> 它常作为压缩流水线的一个前置阶段，但本项目**刻意不接入** Huffman、游程编码（RLE）、算术编码等任何压缩阶段，
> 也不做全文搜索、FM-index 检索或重复片段查找。

---

## 1. 算法约定（核心始终按字节 0..255 处理）

- 输入统一视为字节序列。可接收**文件、十六进制、UTF-8 文本**，进入核心后都是 `Uint8Array`（每字节 0–255，全部 256 种取值合法）。
- 对原块的全部 `n` 个循环移位（rotation）按**字节字典序**排序。
- 取排序后每行的**最后一个字节**组成最后一列 `L`（长度恒为 `n`）。
- `primary` 是“原始未旋转行”（起点偏移 0）在排序结果中的**零基**行号。
- **不添加哨兵**：不会偷偷追加一个输入不可能包含的字节。
- **平局规则（确定性）**：当两个旋转内容完全相同（周期串必然如此），按其**原起点偏移升序**排序，因此任意输入的产物都唯一确定，且可重复。
- **空块**固定表示为 `L = ""`（空）、`primary = 0`；非空块的 `primary` 必须满足 `0 <= primary < n`。

### banana 演示（ASCII）

对 `banana` 的 6 个循环移位排序，`*` 为原始行：

| row | rotation | 末字节 |
|----:|:---------|:-----:|
| 0 | `abanan` | n |
| 1 | `anaban` | n |
| 2 | `ananab` | b |
| **3** | **`banana`** `*` | a |
| 4 | `nabana` | a |
| 5 | `nanaba` | a |

因此：

- **`L = "nnbaaa"`**
- **`primary = 3`**

### LF 逆变换（只凭 `L` 与 `primary`）

自行实现稳定的 Last-to-First 映射，**不读取数据库原文，也不读取正向旋转矩阵**：

1. `counts[c]`：字节 `c` 在 `L` 中出现次数。
2. `C[c]`：排序首列中，字节 `c` **之前**有多少字节（即所有比 `c` 小的字节计数之和）。
3. `occ(row)`：`L[row]` 在 `L[0..row-1]` 中**此前已出现的次数**（**零基出现次数**）。
4. **`LF(row) = C[L[row]] + occ(row)`**。

遍历方向与回填顺序（避免把答案整体旋转）：

- 从 `row = primary` 开始，沿 `LF` 前进；
- 每步取字节 `L[row]`，**从答案尾部向前回填**（位置 `n-1, n-2, …, 0`），然后 `row = LF(row)`；
- 共走 `n` 步，最后一步回到起点时正好写入位置 0。

banana 的逐步行进（`row → L[row] → LF(row)`）：

| 回填位置 | row | 字节 | 下一 row |
|---:|---:|:---:|---:|
| 5 | 3 | a | 2 |
| 4 | 2 | n | 5 |
| 3 | 5 | a | 1 |
| 2 | 1 | n | 4 |
| 1 | 4 | a | 0 |
| 0 | 0 | n | 3 |

回填结果即 `banana`。逆变换复杂度 **O(n)**（额外 O(n) 空间）。

### 复杂度与规模限制

正变换使用**直接比较循环移位**的清晰实现，排序比较器最坏逐字节比较，量级约 **O(n² log n)**。
默认块上限 `--max-block 8192` 字节（可配置），**明确不承诺大文件 / 流式压缩**。
解释用旋转表可对短块展示，但它**不是解码所需输入**。

---

## 2. 导出结构（带版本）

```json
{
  "format": "bwt-byte-block",
  "version": 1,
  "n": 6,
  "primary": 3,
  "lEncoding": "base64",
  "L": "bm5iYWFh",
  "digest": { "algorithm": "sha256", "original": "b493…de4e" },
  "createdAt": "2026-10-06T01:00:00.000Z"
}
```

- `L` 用 **base64（默认）或 hex** 无歧义编码字节；空块为空字符串。
- `digest` 为**可选**的原始字节 SHA-256 摘要。
- **普通解码不声称能检测任意篡改**：没有摘要时，“能解码”绝不等于来源认证。
- 有摘要时，解码响应**单独**给出 `digestVerified`；摘要对不上只影响该校验字段，不影响字节还原本身。
- 旧产物可**脱离原输入、脱离原数据库**，仅凭导出 JSON 单独导入并解码。

### 严格校验与错误码

导入/解码会拒绝：长度不符（`LENGTH_MISMATCH`）、非法 hex/base64（`INVALID_HEX`/`INVALID_BASE64`）、
越界行号（`PRIMARY_OUT_OF_RANGE`，空块 primary 必须为 0）、超过块/输出预算（`BLOCK_TOO_LARGE`/`OUTPUT_BUDGET_EXCEEDED`）、
不支持的编码（`UNSUPPORTED_ENCODING`）、未知记录（`RECORD_NOT_FOUND`）等。

---

## 3. 环境要求

- Node.js **>= 22.5**（开发与实测版本 **v25.5.0**，Windows）。依赖内置的 `node:sqlite`，免原生编译。
- Windows 本地 PowerShell；不依赖 Docker / WSL / 付费服务 / 外部 API。

## 4. 安装、构建、测试

```powershell
npm install
npm run build     # tsc 类型检查并输出到 dist/
npm test          # node --test 跑 24 个测试
npm run demo      # banana / abab / 全相同 / 含零字节 / 空块 / 单字节 往返演示
```

测试覆盖：空块、单字节、全部 256 种字节值、256 字节乱序排列、随机块往返、重复旋转平局（周期串）、
全相同字节、含零字节二进制、错误行号、输出预算、非法编码、长度不符、摘要校验；
并用两种**互相独立**的方法核对——短块的**显式旋转表**与另一种**逐轮表重建**逆变换；
还包含一个跨进程 CLI 测试：导出 → 删除原输入文件与原数据目录 → 新数据目录导入 → 解码，字节完全一致。

## 5. CLI 用法

数据目录默认项目内 `./data`，可用环境变量 `BWT_DATA_DIR` 覆盖。

```powershell
# 启动 HTTP API（--port 0 = 系统分配空闲端口，默认即是 0）
node --no-warnings dist/cli.js serve --port 8731

# 正变换（三种输入）
node dist/cli.js transform --text "banana"
node dist/cli.js transform --hex 00410042ff00 --l-encoding hex
node dist/cli.js transform --file .\sample.bin

# 分页查看旋转行（解释用；--page/--page-size 预算，不影响正式 L 与解码）
node dist/cli.js rotations --record b493d48364afe44d --page 0 --page-size 3
node dist/cli.js rotations --text banana

# 查询单个 LF 步骤（零基）
node dist/cli.js lf --record b493d48364afe44d --row 0

# 独立逆变换：完整字节写入“新文件”，绝不修改原文件
node dist/cli.js decode --record b493d48364afe44d --out .\restored.bin
node dist/cli.js decode --envelope .\export.json

# 导出 / 导入（旧产物脱离原输入）
node dist/cli.js export --record b493d48364afe44d --out .\export.json
node dist/cli.js import --envelope .\export.json

# 比较摘要（只比摘要，不做来源认证）
node dist/cli.js compare --record b493d48364afe44d --text banana

node dist/cli.js list
node dist/cli.js help
```

中文/任意字节解码：当某块不是合法 UTF-8 时，屏幕显示 `utf8: null`，但 `hex` 与 `--out` 写出的二进制结果仍然完全正确。

## 6. HTTP API

仅监听 `127.0.0.1`。启动成功后 stdout 打印一行 JSON，含实际 `baseUrl`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/transform` | 正变换，body：`{encoding:"utf8"\|"hex"\|"base64", data\|text, lEncoding?, withDigest?}` |
| GET | `/records?limit&offset` | 记录列表 |
| GET | `/records/:id` | 查看记录（输入摘要、参数、版本、结果） |
| POST | `/records/:id/rotations` 或 `/rotations` | 分页旋转行（`page`,`pageSize`；也可直接带 `block` 或 `envelope`） |
| POST | `/lf` | 单步 LF：`{recordId|envelope, row}` |
| POST | `/decode` | 独立逆变换：`{recordId|envelope, outputEncoding, outputBudget?, includeUtf8?}` |
| POST | `/export` | 导出版本化 envelope |
| POST | `/compare` | 比较摘要：`{recordId|envelope, encoding,data|text}` |

错误响应统一为 `{ "error": { "code", "message", "details?" } }`，并带对应 HTTP 状态码（如 400/404/409/413）。

### PowerShell 调用示例

```powershell
$base = "http://127.0.0.1:8731"
$t = Invoke-RestMethod "$base/transform" -Method Post -ContentType "application/json" `
     -Body '{"encoding":"utf8","text":"banana"}'
Invoke-RestMethod "$base/lf" -Method Post -ContentType "application/json" `
     -Body (@{ recordId = $t.id; row = 0 } | ConvertTo-Json)
Invoke-RestMethod "$base/decode" -Method Post -ContentType "application/json" `
     -Body (@{ recordId = $t.id; outputEncoding = "hex"; includeUtf8 = $true } | ConvertTo-Json)
```

## 7. 数据库

SQLite 文件位于 `./data/bwt.sqlite`（WAL 模式）。表 `transforms` 保存：
记录 id、块长度 `n`、`primary`、`L` 及其编码、**输入 SHA-256 摘要（不保存原文）**、
来源编码、块上限参数、`bwt_version` 与创建时间。

## 8. 结果大小（再次强调）

以 banana（6 字节）为例，base64 的 `L` 为 8 个字符，另有 JSON 字段与 `primary`。
**BWT 不减小体积**；如需压缩应在其后另接统计编码阶段——本项目不含该部分。

## 9. 目录结构

```
src/
  bwt.ts                       核心：正变换、LF 表、O(n) 逆变换、逐轮重建核对、旋转表
  codec.ts                     输入解析、hex/base64/utf8、SHA-256、版本化 envelope
  db.ts                        node:sqlite 存储层
  service.ts                   业务编排（变换/解码/旋转分页/LF/摘要/导出）
  api.ts                       纯后端 HTTP 服务（无静态页面/前端）
  cli.ts                       CLI + demo
test/                          node:test 测试
```
