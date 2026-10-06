import "./silence-sqlite-warning.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BWT_VERSION } from "./bwt.js";

export interface TransformRecord {
  id: string;
  n: number;
  primary: number;
  l_encoding: "base64" | "hex";
  l_data: string;
  input_sha256: string | null;
  source_encoding: string;
  max_block: number;
  bwt_version: number;
  created_at: string;
}

/**
 * SQLite 存储。只保存输入摘要（不强制保存原文）、参数、变换版本与结果，
 * 旧产物可脱离原输入单独导入解码。
 */
export class BwtStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transforms (
        id TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        "primary" INTEGER NOT NULL,
        l_encoding TEXT NOT NULL,
        l_data TEXT NOT NULL,
        input_sha256 TEXT,
        source_encoding TEXT NOT NULL,
        max_block INTEGER NOT NULL,
        bwt_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  insert(rec: Omit<TransformRecord, "bwt_version" | "created_at"> &
    Partial<Pick<TransformRecord, "bwt_version" | "created_at">>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO transforms
        (id, n, "primary", l_encoding, l_data, input_sha256, source_encoding,
         max_block, bwt_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      rec.id,
      rec.n,
      rec.primary,
      rec.l_encoding,
      rec.l_data,
      rec.input_sha256,
      rec.source_encoding,
      rec.max_block,
      rec.bwt_version ?? BWT_VERSION,
      rec.created_at ?? new Date().toISOString()
    );
  }

  get(id: string): TransformRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM transforms WHERE id = ?`)
      .get(id) as TransformRecord | undefined;
    return row;
  }

  list(limit: number, offset: number): { items: TransformRecord[]; total: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM transforms`).get() as { c: number }).c;
    const items = this.db
      .prepare(`SELECT * FROM transforms ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as TransformRecord[];
    return { items, total };
  }

  close(): void {
    this.db.close();
  }
}
