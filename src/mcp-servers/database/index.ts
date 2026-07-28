#!/usr/bin/env node
/**
 * AgentsGate — Database MCP Server
 *
 * A self-contained SQLite MCP server providing safe, auditable database access
 * with built-in pre-operation table snapshots that pair with AgentsGate's M8
 * rollback engine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { quoteIdentifier } from '../../utils/sql.js';
import {
  DDL_RE,
  DESTRUCTIVE_RE,
  SNAPSHOT_ID_RE,
  SELECT_ONLY_MESSAGE,
  isSelectOrWith,
  assertNoSqliteFileEscape,
  inferTableFromSql,
  validateTableNameTerse as validateTableName,
  persistSnapshot,
  snapshotFileName,
  handleListSnapshots,
  handleDeleteSnapshot,
  buildRowsResult,
  parseMaxRowsFlag,
  jsonResult,
  errorResult,
  caughtErrorResult,
} from '../shared/db-server-utils.js';

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

function isPathWithinAllowedDirectories(
  absolutePath: string,
  allowedDirs: string[],
): boolean {
  if (typeof absolutePath !== 'string' || !Array.isArray(allowedDirs)) return false;
  if (!absolutePath || allowedDirs.length === 0) return false;
  if (absolutePath.includes('\x00')) return false;

  let normalizedPath: string;
  try {
    normalizedPath = path.resolve(path.normalize(absolutePath));
  } catch {
    return false;
  }

  if (!path.isAbsolute(normalizedPath)) {
    throw new Error('Path must be absolute after normalization');
  }

  return allowedDirs.some((dir) => {
    if (typeof dir !== 'string' || !dir) return false;
    if (dir.includes('\x00')) return false;

    let normalizedDir: string;
    try {
      normalizedDir = path.resolve(path.normalize(dir));
    } catch {
      return false;
    }

    if (!path.isAbsolute(normalizedDir)) {
      throw new Error('Allowed directories must be absolute paths after normalization');
    }

    if (normalizedPath === normalizedDir) return true;

    if (normalizedDir === path.sep) {
      return normalizedPath.startsWith(path.sep);
    }

    if (path.sep === '\\' && normalizedDir.match(/^[A-Za-z]:\\?$/)) {
      const dirDrive = normalizedDir.charAt(0).toLowerCase();
      const pathDrive = normalizedPath.charAt(0).toLowerCase();
      return pathDrive === dirDrive && normalizedPath.startsWith(normalizedDir.replace(/\\?$/, '\\'));
    }

    return normalizedPath.startsWith(normalizedDir + path.sep);
  });
}

async function validatePath(requestedPath: string, allowedDirs: string[]): Promise<string> {
  const absolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(process.cwd(), requestedPath);

  const isAllowed = isPathWithinAllowedDirectories(absolute, allowedDirs);
  if (!isAllowed) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${allowedDirs.join(', ')}`,
    );
  }

  try {
    const realPath = await fs.realpath(absolute);
    if (!isPathWithinAllowedDirectories(realPath, allowedDirs)) {
      throw new Error(
        `Access denied - symlink target outside allowed directories: ${realPath} not in ${allowedDirs.join(', ')}`,
      );
    }
    return realPath;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      const parentDir = path.dirname(absolute);
      try {
        const realParentPath = await fs.realpath(parentDir);
        if (!isPathWithinAllowedDirectories(realParentPath, allowedDirs)) {
          throw new Error(
            `Access denied - parent directory outside allowed directories: ${realParentPath} not in ${allowedDirs.join(', ')}`,
          );
        }
        return absolute;
      } catch {
        throw new Error(`Parent directory does not exist: ${parentDir}`);
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function saveSnapshot(
  db: Database.Database,
  snapshotDir: string,
  tableName: string,
  maxBytes: number,
): Promise<string> {
  validateTableName(tableName);

  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all() as Record<string, unknown>[];
  const columns = rows.length > 0
    ? Object.keys(rows[0]!)
    : (db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>).map(c => c.name);

  return persistSnapshot({
    snapshotDir,
    tableName,
    rows,
    columns,
    maxBytes,
    sizeLimitHint: 'Use --max-snapshot-bytes to increase the limit or remove snapshot_table parameter.',
  });
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dbPath: string; allowedDirs: string[]; maxSnapshotBytes: number; maxRows: number } {
  let dbPath: string | undefined;
  let allowedDirsRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && i + 1 < argv.length) {
      dbPath = argv[++i];
    } else if (argv[i] === '--allowed-dirs' && i + 1 < argv.length) {
      allowedDirsRaw = argv[++i];
    }
  }

  if (!dbPath) {
    console.error('Usage: database-mcp --db <path-to-sqlite-file> [--allowed-dirs <dir1,dir2>] [--max-snapshot-bytes=N] [--max-rows=N]');
    process.exit(1);
  }

  const allowedDirs = allowedDirsRaw
    ? allowedDirsRaw.split(',').map((d) => d.trim()).filter(Boolean)
    : [path.dirname(path.resolve(dbPath))];

  let maxSnapshotBytes = 100 * 1024 * 1024; // 100 MB default
  const maxSnapFlag = argv.find(a => a.startsWith('--max-snapshot-bytes='));
  if (maxSnapFlag) {
    const val = parseInt(maxSnapFlag.split('=')[1]!, 10);
    if (!isNaN(val) && val > 0) maxSnapshotBytes = val;
  }

  const maxRows = parseMaxRowsFlag(argv);

  return { dbPath, allowedDirs, maxSnapshotBytes, maxRows };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const { dbPath, allowedDirs, maxSnapshotBytes, maxRows } = parseArgs(process.argv.slice(2));

// Validate db path is within allowed dirs
const resolvedDbPath = await validatePath(dbPath, allowedDirs);
const dbDir = path.dirname(resolvedDbPath);
const snapshotDir = path.join(dbDir, '.agentsgate-snapshots');

// Open the database
const db: Database.Database = new Database(resolvedDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'agentsgate-database',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Tool: query
// ---------------------------------------------------------------------------

server.tool(
  'query',
  'Execute a read-only SQL SELECT statement',
  {
    sql: z.string().describe('SELECT statement to execute'),
    params: z.array(z.unknown()).optional().describe('Positional parameters'),
    limit: z.number().int().min(1).max(10000).default(500).describe('Max rows returned'),
  },
  async ({ sql, params, limit }) => {
    try {
      if (!isSelectOrWith(sql)) {
        return errorResult(SELECT_ONLY_MESSAGE);
      }
      assertNoSqliteFileEscape(sql);
      const rows = db.prepare(sql).all(...(params ?? [])) as unknown[];
      return buildRowsResult(rows, limit, maxRows);
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: execute
// ---------------------------------------------------------------------------

server.tool(
  'execute',
  'Execute a DML statement (INSERT, UPDATE, DELETE)',
  {
    sql: z.string().describe('INSERT, UPDATE, or DELETE statement'),
    params: z.array(z.unknown()).optional(),
    snapshot_table: z.string().optional().describe('Table name to snapshot before execution'),
  },
  async ({ sql, params, snapshot_table }) => {
    try {
      if (DDL_RE.test(sql.toUpperCase())) {
        return errorResult('Use execute_ddl for DDL statements');
      }
      assertNoSqliteFileEscape(sql);

      const effectiveTable = snapshot_table ?? inferTableFromSql(sql);
      let snapshotId: string | undefined;
      if (effectiveTable) {
        try {
          snapshotId = await saveSnapshot(db, snapshotDir, effectiveTable, maxSnapshotBytes);
        } catch { /* snapshot failure does not block execution */ }
      }

      const result = db.prepare(sql).run(...(params ?? []));
      const response: Record<string, unknown> = {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
      if (snapshotId !== undefined) {
        response['snapshot_id'] = snapshotId;
      }
      return jsonResult(response);
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: execute_ddl
// ---------------------------------------------------------------------------

server.tool(
  'execute_ddl',
  'Execute a DDL statement (CREATE, ALTER, DROP, TRUNCATE)',
  {
    sql: z.string().describe('DDL statement (CREATE, ALTER, DROP, TRUNCATE)'),
    snapshot_table: z.string().optional().describe('Table name to snapshot before execution'),
    confirm_destructive: z
      .boolean()
      .default(false)
      .describe('Must be true for DROP or TRUNCATE'),
  },
  async ({ sql, snapshot_table, confirm_destructive }) => {
    try {
      if (DESTRUCTIVE_RE.test(sql.toUpperCase()) && confirm_destructive !== true) {
        return errorResult('Destructive DDL requires confirm_destructive: true');
      }
      assertNoSqliteFileEscape(sql);

      const effectiveTable = snapshot_table ?? inferTableFromSql(sql);
      let snapshotId: string | undefined;
      if (effectiveTable) {
        try {
          snapshotId = await saveSnapshot(db, snapshotDir, effectiveTable, maxSnapshotBytes);
        } catch { /* snapshot failure does not block execution */ }
      }

      const result = db.prepare(sql).run();
      const response: Record<string, unknown> = { changes: result.changes };
      if (snapshotId !== undefined) {
        response['snapshot_id'] = snapshotId;
      }
      return jsonResult(response);
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: execute_transaction
// ---------------------------------------------------------------------------

server.tool(
  'execute_transaction',
  'Execute multiple DML statements atomically in a single SQLite transaction',
  {
    statements: z.array(z.object({
      sql: z.string(),
      params: z.array(z.unknown()).optional(),
    })).min(1),
    snapshot_table: z.string().optional(),
  },
  async ({ statements, snapshot_table }) => {
    try {
      for (const stmt of statements) {
        if (DDL_RE.test(stmt.sql.toUpperCase())) {
          return errorResult('Use execute_ddl for DDL statements; execute_transaction is DML only');
        }
        assertNoSqliteFileEscape(stmt.sql);
      }

      const effectiveTable = snapshot_table ?? inferTableFromSql(statements[0]!.sql);
      let snapshotId: string | undefined;
      if (effectiveTable) {
        try {
          snapshotId = await saveSnapshot(db, snapshotDir, effectiveTable, maxSnapshotBytes);
        } catch { /* snapshot failure does not block execution */ }
      }

      const results: Array<{ changes: number; lastInsertRowid: unknown }> = [];
      const runAll = db.transaction(() => {
        for (const { sql, params } of statements) {
          const r = db.prepare(sql).run(...(params ?? []));
          results.push({ changes: r.changes, lastInsertRowid: r.lastInsertRowid });
        }
      });
      runAll();

      const response: Record<string, unknown> = {
        statements: results.length,
        totalChanges: results.reduce((sum, r) => sum + r.changes, 0),
        results,
      };
      if (snapshotId !== undefined) response['snapshot_id'] = snapshotId;

      return jsonResult(response);
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: list_tables
// ---------------------------------------------------------------------------

server.tool(
  'list_tables',
  'List all user tables and views in the database',
  {},
  async () => {
    try {
      const tables = db
        .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
        .all() as Array<{ name: string; type: string }>;
      return jsonResult({ tables });
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: describe_table
// ---------------------------------------------------------------------------

server.tool(
  'describe_table',
  'Get the schema of a table (columns, indices, foreign keys, row count)',
  {
    table: z.string().describe('Table name'),
  },
  async ({ table }) => {
    try {
      validateTableName(table);
      const quoted = quoteIdentifier(table);

      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all();
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all();
      const indices = db.prepare(`PRAGMA index_list(${quoted})`).all();
      const countRow = db.prepare(`SELECT COUNT(*) as c FROM ${quoted}`).get() as { c: number };

      return jsonResult({
        table,
        columns,
        foreignKeys,
        indices,
        rowCount: countRow.c,
      });
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: restore_snapshot
// ---------------------------------------------------------------------------

server.tool(
  'restore_snapshot',
  'Restore a table from a previously saved snapshot',
  {
    snapshot_id: z.string().describe('UUID returned by execute or execute_ddl'),
    table: z.string().describe('Table name to restore'),
  },
  async ({ snapshot_id, table }) => {
    try {
      validateTableName(table);
      // Prevent path traversal: snapshot_id must be a valid UUID
      if (!SNAPSHOT_ID_RE.test(snapshot_id)) {
        return errorResult('Invalid snapshot_id format (must be a UUID)');
      }
      const filename = snapshotFileName(snapshot_id, table);
      const filePath = path.join(snapshotDir, filename);

      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        return errorResult(`Snapshot not found: ${filename}`);
      }

      const rows = JSON.parse(content) as Record<string, unknown>[];
      const quoted = quoteIdentifier(table);

      const restoreInTransaction = db.transaction(() => {
        db.prepare(`DELETE FROM ${quoted}`).run();

        if (rows.length === 0) return 0;

        const columns = Object.keys(rows[0] as object);
        const quotedColumns = columns.map(quoteIdentifier).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const insertSql = `INSERT INTO ${quoted} (${quotedColumns}) VALUES (${placeholders})`;
        const insertStmt = db.prepare(insertSql);

        for (const row of rows) {
          const values = columns.map((col) => (row as Record<string, unknown>)[col]);
          insertStmt.run(values);
        }

        return rows.length;
      });

      const rowsRestored = restoreInTransaction() as number;

      return jsonResult({ restored: true, rowsRestored });
    } catch (err) {
      return caughtErrorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: list_snapshots
// ---------------------------------------------------------------------------

server.tool(
  'list_snapshots',
  'List available snapshots',
  {
    table: z.string().optional().describe('Filter by table name'),
  },
  async ({ table }) => handleListSnapshots(snapshotDir, table),
);

// ---------------------------------------------------------------------------
// Tool: delete_snapshot
// ---------------------------------------------------------------------------

server.tool(
  'delete_snapshot',
  'Delete a snapshot file by snapshot_id and table name',
  {
    snapshot_id: z.string().describe('Snapshot UUID (from list_snapshots or execute response)'),
    table: z.string().describe('Table name the snapshot belongs to'),
  },
  async ({ snapshot_id, table }) => handleDeleteSnapshot(snapshotDir, snapshot_id, table, validateTableName),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`AgentsGate Database MCP Server running on stdio (db: ${resolvedDbPath})`);
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
