import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TRANSFORM_VERSION } from './core/bwt.js';
import { sha256 } from './core/digest.js';
import { AppError } from './errors.js';

export interface StoredBlock {
  id: string;
  inputSha256: string;
  inputFormat: string;
      sourceName?: string | null;
  length: number;
  primary: number;
  lBytes: Uint8Array;
  maxBlockBytes: number;
  transformVersion: string;
  createdAt: string;
}

export interface NewBlockRecord {
  inputBytes: Uint8Array;
  inputFormat: string;
  sourceName?: string;
  L: Uint8Array;
  primary: number;
  maxBlockBytes: number;
}

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      input_sha256 TEXT NOT NULL,
      input_format TEXT NOT NULL,
      source_name TEXT,
      length INTEGER NOT NULL,
      primary_row INTEGER NOT NULL,
      l_bytes BLOB NOT NULL,
      max_block_bytes INTEGER NOT NULL,
      transform_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_created_at ON blocks(created_at DESC);
  `);
  return database;
}

function normalizeBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new AppError('INTERNAL_ERROR', '数据库中的 L BLOB 类型异常。', 500);
}

function mapRow(row: unknown): StoredBlock {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    inputSha256: String(value.input_sha256),
    inputFormat: String(value.input_format),
    sourceName: value.source_name === null || value.source_name === undefined ? null : String(value.source_name),
    length: Number(value.length),
    primary: Number(value.primary_row),
    lBytes: normalizeBlob(value.l_bytes),
    maxBlockBytes: Number(value.max_block_bytes),
    transformVersion: String(value.transform_version),
    createdAt: String(value.created_at),
  };
}

export function insertBlock(database: DatabaseSync, record: NewBlockRecord): StoredBlock {
  const createdAt = new Date().toISOString();
  const id = `${record.inputBytes.length.toString(16)}-${sha256(record.L).slice(0, 16)}-${record.primary.toString(16).padStart(4, '0')}`;
  const existing = getBlock(database, id);
  if (existing) return existing;

  database.prepare(`
    INSERT INTO blocks (
      id, input_sha256, input_format, source_name, length, primary_row,
      l_bytes, max_block_bytes, transform_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sha256(record.inputBytes),
    record.inputFormat,
    record.sourceName ?? null,
    record.inputBytes.length,
    record.primary,
    record.L,
    record.maxBlockBytes,
    TRANSFORM_VERSION,
    createdAt,
  );
  return getBlockRequired(database, id);
}

export function getBlock(database: DatabaseSync, id: string): StoredBlock | null {
  const row = database.prepare('SELECT * FROM blocks WHERE id = ?').get(id);
  return row === undefined ? null : mapRow(row);
}

export function getBlockRequired(database: DatabaseSync, id: string): StoredBlock {
  const block = getBlock(database, id);
  if (!block) throw new AppError('NOT_FOUND', `未找到块 ${id}。`, 404);
  return block;
}

export interface ListBlockSummary {
  id: string;
  length: number;
  primary: number;
  inputSha256: string;
      sourceName?: string | null;
  createdAt: string;
}

export function listBlocks(database: DatabaseSync, limit: number, offset: number): ListBlockSummary[] {
  const rows = database
    .prepare('SELECT id, length, primary_row, input_sha256, source_name, created_at FROM blocks ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?')
    .all(limit, offset);
  return (rows as unknown[]).map((row) => {
    const value = row as Record<string, unknown>;
    return {
      id: String(value.id),
      length: Number(value.length),
      primary: Number(value.primary_row),
      inputSha256: String(value.input_sha256),
      sourceName: value.source_name === null || value.source_name === undefined ? null : String(value.source_name),
      createdAt: String(value.created_at),
    };
  });
}
