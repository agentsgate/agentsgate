#!/usr/bin/env node
/**
 * AgentsGate — MySQL MCP Server
 *
 * Self-contained MySQL MCP server providing safe, auditable database access
 * with pre-operation table snapshots that pair with AgentsGate's M8 rollback engine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import mysql from 'mysql2/promise';
import { quoteIdentifierMysql as quoteIdentifier } from '../../utils/sql.js';
import {
  MYSQL_DDL_RE as DDL_RE,
  DESTRUCTIVE_RE,
  SNAPSHOT_ID_RE,
  SELECT_ONLY_MESSAGE,
  isSelectOrWith,
  assertNoMysqlFileEscape,
  inferTableFromSql,
  validateTableNameVerbose as validateTableName,
  persistSnapshot,
  snapshotFileName,
  handleListSnapshots,
  handleDeleteSnapshot,
  buildRowsResult,
  parseMaxRowsFlag,
  resolveDefaultSnapshotDir,
  redactConnectionString,
  toMysqlParams,
  jsonResult,
  errorResult,
  caughtErrorResult,
} from '../shared/db-server-utils.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  connectionString: string;
  snapshotDir: string;
  maxSnapshotBytes: number;
  maxRows: number;
} {
  let connectionString = process.env['MYSQL_URL'] ?? process.env['DATABASE_URL'] ?? '';
  let snapshotDirOverride: string | undefined;
  let maxSnapshotBytes = 100 * 1024 * 1024;

  let host = 'localhost';
  let port = '3306';
  let user = '';
  let password = '';
  let database = '';
  let hasSeparateFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === '--connection-string' || arg === '--conn') && i + 1 < argv.length) {
      connectionString = argv[++i]!;
    } else if (arg.startsWith('--connection-string=')) {
      connectionString = arg.slice('--connection-string='.length);
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
      hasSeparateFlags = true;
    } else if (arg.startsWith('--port=')) {
      port = arg.slice('--port='.length);
      hasSeparateFlags = true;
    } else if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
      hasSeparateFlags = true;
    } else if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
      hasSeparateFlags = true;
    } else if (arg.startsWith('--database=')) {
      database = arg.slice('--database='.length);
      hasSeparateFlags = true;
    } else if (arg.startsWith('--snapshot-dir=')) {
      snapshotDirOverride = arg.slice('--snapshot-dir='.length);
    } else if (arg.startsWith('--max-snapshot-bytes=')) {
      const val = parseInt(arg.split('=')[1]!, 10);
      if (!isNaN(val) && val > 0) maxSnapshotBytes = val;
    }
  }

  if (!connectionString && hasSeparateFlags) {
    connectionString = `mysql://${user}:${password}@${host}:${port}/${database}`;
  }

  if (!connectionString) {
    console.error('Usage: mysql-database-mcp --connection-string mysql://user:pass@host:3306/db');
    console.error('  or set MYSQL_URL / DATABASE_URL environment variable');
    process.exit(1);
  }

  const snapshotDir = snapshotDirOverride
    ? path.resolve(snapshotDirOverride)
    : resolveDefaultSnapshotDir(connectionString, 'mysql-unknown');

  const maxRows = parseMaxRowsFlag(argv);

  return { connectionString, snapshotDir, maxSnapshotBytes, maxRows };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const { connectionString, snapshotDir, maxSnapshotBytes, maxRows } = parseArgs(process.argv.slice(2));
const pool = mysql.createPool(connectionString);

process.on('exit', () => { pool.end().catch(() => {}); });

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function saveSnapshot(
  pool: mysql.Pool,
  tableName: string,
  maxBytes: number,
): Promise<string> {
  validateTableName(tableName);
  const quoted = quoteIdentifier(tableName);
  const [rows] = await pool.execute(`SELECT * FROM ${quoted}`) as [mysql.RowDataPacket[], mysql.FieldPacket[]];
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

  return persistSnapshot({
    snapshotDir,
    tableName,
    rows,
    columns,
    maxBytes,
    sizeLimitHint: 'Use --max-snapshot-bytes to increase the limit.',
  });
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'agentsgate-mysql-database',
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
    params: z.array(z.unknown()).optional().describe('Positional parameters (?)'),
    limit: z.number().int().min(1).max(10000).default(500).describe('Max rows returned'),
  },
  async ({ sql, params, limit }) => {
    try {
      if (!isSelectOrWith(sql)) {
        return errorResult(SELECT_ONLY_MESSAGE);
      }
      assertNoMysqlFileEscape(sql);
      const [rows] = await pool.execute(sql, toMysqlParams(params ?? [])) as [mysql.RowDataPacket[], mysql.FieldPacket[]];
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

      const effectiveTable = snapshot_table ?? inferTableFromSql(sql);
      let snapshotId: string | undefined;
      if (effectiveTable) {
        try {
          snapshotId = await saveSnapshot(pool, effectiveTable, maxSnapshotBytes);
        } catch { /* snapshot failure does not block execution */ }
      }

      const [result] = await pool.execute(sql, toMysqlParams(params ?? [])) as [mysql.OkPacket, mysql.FieldPacket[]];
      const response: Record<string, unknown> = {
        changes: result.affectedRows,
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

      const effectiveTable = snapshot_table ?? inferTableFromSql(sql);
      let snapshotId: string | undefined;
      if (effectiveTable) {
        try {
          snapshotId = await saveSnapshot(pool, effectiveTable, maxSnapshotBytes);
        } catch { /* snapshot failure does not block execution */ }
      }

      await pool.query(sql);
      const response: Record<string, unknown> = { changes: null };
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
  'Execute multiple DML statements atomically in a single MySQL transaction',
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
          return errorResult('Use execute_ddl for DDL; execute_transaction is DML only');
        }
      }

      const effectiveTable = snapshot_table ?? inferTableFromSql(statements[0]!.sql);
      let snapshotId: string | undefined;
      if (effectiveTable) {
        try {
          snapshotId = await saveSnapshot(pool, effectiveTable, maxSnapshotBytes);
        } catch { /* snapshot failure does not block */ }
      }

      const conn = await pool.getConnection();
      const results: Array<{ changes: number }> = [];
      try {
        await conn.beginTransaction();
        for (const { sql, params } of statements) {
          const [result] = await conn.execute(sql, toMysqlParams(params ?? [])) as [mysql.OkPacket, mysql.FieldPacket[]];
          results.push({ changes: result.affectedRows });
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }

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
      const [rows] = await pool.execute(
        `SELECT TABLE_NAME as name, TABLE_TYPE as type
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME`
      ) as [mysql.RowDataPacket[], mysql.FieldPacket[]];
      return jsonResult({ tables: rows });
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
  'Get the schema of a table (columns, foreign keys, row count)',
  {
    table: z.string().describe('Table name'),
  },
  async ({ table }) => {
    try {
      validateTableName(table);
      const quoted = quoteIdentifier(table);

      const [columnsRows] = await pool.execute(
        `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type,
                IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [table]
      ) as [mysql.RowDataPacket[], mysql.FieldPacket[]];

      const [countRows] = await pool.execute(
        `SELECT COUNT(*) as c FROM ${quoted}`
      ) as [mysql.RowDataPacket[], mysql.FieldPacket[]];

      const [fkRows] = await pool.execute(
        `SELECT
           COLUMN_NAME as column_name,
           REFERENCED_TABLE_NAME as foreign_table_name,
           REFERENCED_COLUMN_NAME as foreign_column_name
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [table]
      ) as [mysql.RowDataPacket[], mysql.FieldPacket[]];

      return jsonResult({
        table,
        columns: columnsRows,
        foreignKeys: fkRows,
        rowCount: Number(countRows[0]?.['c'] ?? 0),
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

      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, 'utf-8');
      } catch {
        return errorResult(`Snapshot not found: ${filename}`);
      }

      const parsed = JSON.parse(fileContent) as { version?: number; rows: Record<string, unknown>[]; columns: string[] };
      const { rows, columns } = parsed;
      const quoted = quoteIdentifier(table);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute(`DELETE FROM ${quoted}`);
        if (rows.length > 0 && columns.length > 0) {
          const colList = columns.map(c => quoteIdentifier(c)).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          for (const row of rows) {
            const values = columns.map(c => row[c] ?? null);
            await conn.execute(`INSERT INTO ${quoted} (${colList}) VALUES (${placeholders})`, toMysqlParams(values));
          }
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      return jsonResult({ restored: true, rowsRestored: rows.length });
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
  console.error(`AgentsGate MySQL MCP Server running on stdio`);
  console.error(`Connection: ${redactConnectionString(connectionString)}`);
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
