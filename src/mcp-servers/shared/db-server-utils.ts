/**
 * AgentsGate — Shared helpers for the database MCP servers
 * (SQLite, PostgreSQL, MySQL).
 *
 * Only logic that is genuinely identical across dialects lives here.
 * Dialect-specific concerns (identifier quoting, parameter placeholders,
 * snapshot row capture SQL, transaction APIs) stay in each server file.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

/** Text-only MCP tool result shape shared by all database servers. */
export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorResult(message: string): ToolTextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Standard catch-block result: err.message (or String(err)) with isError. */
export function caughtErrorResult(err: unknown): ToolTextResult {
  return errorResult(errorMessage(err));
}

export function jsonResult(value: unknown): ToolTextResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// ---------------------------------------------------------------------------
// SQL classification
// ---------------------------------------------------------------------------

/** DDL keyword guard used by the SQLite and PostgreSQL servers (includes PRAGMA). */
export const DDL_RE = /\b(DROP|CREATE|ALTER|TRUNCATE|PRAGMA)\b/i;

/** DDL keyword guard used by the MySQL server (MySQL has no PRAGMA). */
export const MYSQL_DDL_RE = /\b(DROP|CREATE|ALTER|TRUNCATE)\b/i;

/** Destructive DDL that requires confirm_destructive: true. */
export const DESTRUCTIVE_RE = /\b(DROP|TRUNCATE)\b/i;

/**
 * SQLite statements that reach the filesystem outside the configured database
 * file, escaping the `--allowed-dirs` sandbox: ATTACH/DETACH another database,
 * or VACUUM ... INTO a file. Blocked in every SQL-accepting tool.
 */
export const SQLITE_FILE_ESCAPE_RE = /\b(?:ATTACH|DETACH)\b|\bVACUUM\b[\s\S]*?\bINTO\b/i;

/**
 * MySQL constructs that read or write server-side files (require FILE privilege
 * but must never be reachable through the read-only query tool):
 * SELECT ... INTO OUTFILE/DUMPFILE and the LOAD_FILE() function.
 */
export const MYSQL_FILE_ESCAPE_RE = /\bINTO\s+(?:OUT|DUMP)FILE\b|\bLOAD_FILE\s*\(/i;

/** Throw if `sql` contains a SQLite filesystem-escape statement (ATTACH/DETACH/VACUUM INTO). */
export function assertNoSqliteFileEscape(sql: string): void {
  if (SQLITE_FILE_ESCAPE_RE.test(sql)) {
    throw new Error('ATTACH, DETACH, and VACUUM ... INTO are not permitted (filesystem sandbox escape)');
  }
}

/** Throw if `sql` contains a MySQL server-side file read/write construct. */
export function assertNoMysqlFileEscape(sql: string): void {
  if (MYSQL_FILE_ESCAPE_RE.test(sql)) {
    throw new Error('INTO OUTFILE/DUMPFILE and LOAD_FILE() are not permitted (filesystem access)');
  }
}

/** Error message returned by the query tool for non-read-only SQL. */
export const SELECT_ONLY_MESSAGE = 'Only SELECT/WITH queries allowed in query tool';

/** True when the statement starts with SELECT or WITH (read-only guard). */
export function isSelectOrWith(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  return upper.startsWith('SELECT') || upper.startsWith('WITH');
}

/** Infer the target table name from a DML/DDL statement. */
export function inferTableFromSql(sql: string): string | undefined {
  const match = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE|DROP\s+TABLE)\s+["`]?(\w+)["`]?/i.exec(sql);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Table name validation
// ---------------------------------------------------------------------------

export const TABLE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

function createTableNameValidator(makeMessage: (name: string) => string): (name: string) => void {
  return (name: string): void => {
    if (!TABLE_NAME_RE.test(name)) {
      throw new Error(makeMessage(name));
    }
  };
}

/** SQLite server variant — terse error message. */
export const validateTableNameTerse = createTableNameValidator(() => 'Invalid table name');

/** MySQL / PostgreSQL server variant — verbose error message. */
export const validateTableNameVerbose = createTableNameValidator(
  (name) => `Invalid table name: "${name}". Only alphanumeric and underscore allowed.`,
);

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Prevent path traversal: snapshot ids must look like a UUID. */
export const SNAPSHOT_ID_RE = /^[0-9a-f-]{36}$/;

export function snapshotFileName(snapshotId: string, tableName: string): string {
  return `${snapshotId}_${tableName}.json`;
}

export interface PersistSnapshotOptions {
  snapshotDir: string;
  tableName: string;
  rows: unknown[];
  columns: string[];
  maxBytes: number;
  /** Dialect-specific hint appended to the size-limit error message. */
  sizeLimitHint: string;
}

/**
 * Serialize captured rows/columns, enforce the size limit, and write the
 * snapshot file. Returns the new snapshot id. Callers are responsible for
 * validating the table name and capturing rows/columns (dialect-specific).
 */
export async function persistSnapshot(options: PersistSnapshotOptions): Promise<string> {
  const { snapshotDir, tableName, rows, columns, maxBytes, sizeLimitHint } = options;

  const payload = JSON.stringify({
    version: 1,
    tableName,
    capturedAt: new Date().toISOString(),
    rows,
    columns,
  });

  const estimatedBytes = Buffer.byteLength(payload, 'utf8');
  if (estimatedBytes > maxBytes) {
    throw new Error(
      `Snapshot too large: ${estimatedBytes} bytes exceeds limit of ${maxBytes} bytes. ` +
      sizeLimitHint,
    );
  }

  await fs.mkdir(snapshotDir, { recursive: true });
  const snapshotId = randomUUID();
  await fs.writeFile(path.join(snapshotDir, snapshotFileName(snapshotId, tableName)), payload, 'utf8');
  return snapshotId;
}

/** Complete handler body for the list_snapshots tool (identical across dialects). */
export async function handleListSnapshots(snapshotDir: string, table?: string): Promise<ToolTextResult> {
  try {
    let files: string[];
    try {
      files = await fs.readdir(snapshotDir);
    } catch {
      return jsonResult({ snapshots: [] });
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const snapshots: Array<{
      snapshot_id: string;
      table: string;
      createdAt: string;
      sizeBytes: number;
    }> = [];

    for (const file of jsonFiles) {
      // Filename format: <uuid>_<tableName>.json
      const withoutExt = file.slice(0, -5);
      const underscoreIdx = withoutExt.indexOf('_');
      if (underscoreIdx === -1) continue;

      const snapshotId = withoutExt.slice(0, underscoreIdx);
      const tableName = withoutExt.slice(underscoreIdx + 1);

      if (table && tableName !== table) continue;

      const filePath = path.join(snapshotDir, file);
      const stat = await fs.stat(filePath);
      snapshots.push({
        snapshot_id: snapshotId,
        table: tableName,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      });
    }

    snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return jsonResult({ snapshots });
  } catch (err) {
    return caughtErrorResult(err);
  }
}

/** Complete handler body for the delete_snapshot tool (identical across dialects). */
export async function handleDeleteSnapshot(
  snapshotDir: string,
  snapshot_id: string,
  table: string,
  validateTableName: (name: string) => void,
): Promise<ToolTextResult> {
  try {
    validateTableName(table);
    if (!SNAPSHOT_ID_RE.test(snapshot_id)) {
      return errorResult('Invalid snapshot_id format');
    }
    const file = path.join(snapshotDir, snapshotFileName(snapshot_id, table));
    await fs.unlink(file);
    return jsonResult({ deleted: true, snapshot_id, table });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return jsonResult({ deleted: false, reason: 'not found' });
    }
    return caughtErrorResult(err);
  }
}

// ---------------------------------------------------------------------------
// Query result shaping
// ---------------------------------------------------------------------------

/** Apply row limit + truncation warning and build the query tool result. */
export function buildRowsResult(rows: unknown[], limit: number, maxRows: number): ToolTextResult {
  const effectiveLimit = Math.min(limit, maxRows);
  const limited = rows.length > effectiveLimit ? rows.slice(0, effectiveLimit) : rows;
  const truncated = rows.length > effectiveLimit;
  return jsonResult(truncated
    ? { rows: limited, truncated: true, totalReturnedRows: effectiveLimit, warning: `Result truncated to ${effectiveLimit} rows` }
    : { rows: limited });
}

// ---------------------------------------------------------------------------
// Connection-string helpers (network servers: MySQL / PostgreSQL)
// ---------------------------------------------------------------------------

/**
 * Default snapshot directory derived from the connection string:
 * ~/.agentsgate-snapshots/<host>_<db>, falling back to the given tag when
 * the connection string is not a parseable URL.
 */
export function resolveDefaultSnapshotDir(connectionString: string, fallbackTag: string): string {
  let tag = fallbackTag;
  try {
    const url = new URL(connectionString);
    const host = url.hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dbName = url.pathname.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
    tag = `${host}_${dbName}`;
  } catch { /* use fallback tag */ }
  return path.join(os.homedir(), '.agentsgate-snapshots', tag);
}

/**
 * Mask the password portion of a connection string for logging.
 * URL-aware: a password containing `:` or `@` is fully masked (the naive
 * `/:([^:@]+)@/` regex would leak the fragment before the first such char).
 * Falls back to whole-string redaction for values that do not parse as a URL.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (!url.password) return connectionString;
    url.password = '***';
    return url.toString();
  } catch {
    // Unparseable — redact anything that looks like credentials wholesale
    // rather than risk leaking part of a secret via partial regex surgery.
    return connectionString.replace(/\/\/[^@/]+@/, '//***@');
  }
}

// ---------------------------------------------------------------------------
// CLI flag helpers
// ---------------------------------------------------------------------------

/** Parse --max-rows=N (first occurrence wins), defaulting to 10,000. */
export function parseMaxRowsFlag(argv: string[]): number {
  const maxRowsFlag = argv.find(a => a.startsWith('--max-rows='));
  return maxRowsFlag ? parseInt(maxRowsFlag.split('=')[1]!, 10) : 10_000;
}

// ---------------------------------------------------------------------------
// mysql2 type-safe param helpers (shared by the MySQL server and adapter)
// ---------------------------------------------------------------------------

/** mysql2 accepts these types as positional query parameter values. */
export type MysqlParam = string | number | boolean | null | Buffer | Date | bigint;

/** Safely cast unknown[] to MysqlParam[] for mysql2 parameterized queries. */
export function toMysqlParams(values: unknown[]): MysqlParam[] {
  return values as MysqlParam[];
}
