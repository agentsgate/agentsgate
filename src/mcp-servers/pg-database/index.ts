#!/usr/bin/env node
/**
 * AgentsGate — PostgreSQL MCP Server
 *
 * Self-contained PostgreSQL MCP server providing safe, auditable database access
 * with pre-operation table snapshots that pair with AgentsGate's M8 rollback engine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import pg from 'pg';
import { quoteIdentifier } from '../../utils/sql.js';
import {
  DDL_RE,
  DESTRUCTIVE_RE,
  SNAPSHOT_ID_RE,
  SELECT_ONLY_MESSAGE,
  isSelectOrWith,
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
  jsonResult,
  errorResult,
  caughtErrorResult,
} from '../shared/db-server-utils.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  connectionString: string;
  snapshotDir: string;
  maxSnapshotBytes: number;
  maxRows: number;
} {
  let connectionString = process.env['DATABASE_URL'] ?? '';
  let snapshotDirOverride: string | undefined;
  let maxSnapshotBytes = 100 * 1024 * 1024;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === '--connection-string' || arg === '--conn') && i + 1 < argv.length) {
      connectionString = argv[++i]!;
    } else if (arg.startsWith('--connection-string=')) {
      connectionString = arg.slice('--connection-string='.length);
    } else if (arg.startsWith('--snapshot-dir=')) {
      snapshotDirOverride = arg.slice('--snapshot-dir='.length);
    } else if (arg.startsWith('--max-snapshot-bytes=')) {
      const val = parseInt(arg.split('=')[1]!, 10);
      if (!isNaN(val) && val > 0) maxSnapshotBytes = val;
    }
  }

  if (!connectionString) {
    console.error('Usage: pg-database-mcp --connection-string postgresql://user:pass@host:5432/db');
    console.error('  or set DATABASE_URL environment variable');
    process.exit(1);
  }

  const snapshotDir = snapshotDirOverride
    ? path.resolve(snapshotDirOverride)
    : resolveDefaultSnapshotDir(connectionString, 'pg-unknown');

  const maxRows = parseMaxRowsFlag(argv);

  return { connectionString, snapshotDir, maxSnapshotBytes, maxRows };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const { connectionString, snapshotDir, maxSnapshotBytes, maxRows } = parseArgs(process.argv.slice(2));
const pool = new Pool({ connectionString });

process.on('exit', () => { pool.end().catch(() => {}); });

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function saveSnapshot(
  client: pg.PoolClient,
  tableName: string,
  maxBytes: number,
): Promise<string> {
  validateTableName(tableName);
  const quoted = quoteIdentifier(tableName);

  const result = await client.query(`SELECT * FROM ${quoted}`);
  const rows = result.rows;
  const columns = result.fields.map((f: pg.FieldDef) => f.name);

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
  name: 'agentsgate-pg-database',
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
    params: z.array(z.unknown()).optional().describe('Positional parameters ($1, $2, ...)'),
    limit: z.number().int().min(1).max(10000).default(500).describe('Max rows returned'),
  },
  async ({ sql, params, limit }) => {
    try {
      if (!isSelectOrWith(sql)) {
        return errorResult(SELECT_ONLY_MESSAGE);
      }
      // Run inside a READ ONLY transaction so data-modifying CTEs
      // (e.g. `WITH d AS (DELETE FROM t RETURNING *) SELECT ...`) are rejected
      // by PostgreSQL rather than silently mutating data through the query tool.
      const client = await pool.connect();
      let allRows: Record<string, unknown>[];
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query(sql, (params as unknown[]) ?? []);
        await client.query('COMMIT');
        allRows = result.rows as Record<string, unknown>[];
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
        throw err;
      } finally {
        client.release();
      }
      return buildRowsResult(allRows, limit, maxRows);
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
          const client = await pool.connect();
          try {
            snapshotId = await saveSnapshot(client, effectiveTable, maxSnapshotBytes);
          } finally {
            client.release();
          }
        } catch { /* snapshot failure does not block execution */ }
      }

      const result = await pool.query(sql, (params as unknown[]) ?? []);
      const response: Record<string, unknown> = {
        changes: result.rowCount,
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
          const client = await pool.connect();
          try {
            snapshotId = await saveSnapshot(client, effectiveTable, maxSnapshotBytes);
          } finally {
            client.release();
          }
        } catch { /* snapshot failure does not block execution */ }
      }

      // Pass an explicit (empty) parameter array to force the extended query
      // protocol, which restricts execution to a single statement — this blocks
      // stacked statements (`CREATE ...; DROP audit_log; --`) that the simple
      // protocol would run together, bypassing the snapshot/confirm intent.
      const result = await pool.query(sql, []);
      const response: Record<string, unknown> = { changes: result.rowCount };
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
  'Execute multiple DML statements atomically in a single PostgreSQL transaction',
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
          const snapClient = await pool.connect();
          try {
            snapshotId = await saveSnapshot(snapClient, effectiveTable, maxSnapshotBytes);
          } finally {
            snapClient.release();
          }
        } catch { /* snapshot failure does not block */ }
      }

      const client = await pool.connect();
      const results: Array<{ changes: number }> = [];
      try {
        await client.query('BEGIN');
        for (const { sql, params } of statements) {
          const r = await client.query(sql, params ?? []);
          results.push({ changes: r.rowCount ?? 0 });
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
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
      const result = await pool.query(
        `SELECT table_name as name, table_type as type
         FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_name`
      );
      return jsonResult({ tables: result.rows });
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

      const [columnsResult, countResult, fkResult] = await Promise.all([
        pool.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY ordinal_position`,
          [table]
        ),
        pool.query(`SELECT COUNT(*) as c FROM ${quoted}`),
        pool.query(
          `SELECT
             kcu.column_name,
             ccu.table_name AS foreign_table_name,
             ccu.column_name AS foreign_column_name
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
          [table]
        ),
      ]);

      return jsonResult({
        table,
        columns: columnsResult.rows,
        foreignKeys: fkResult.rows,
        rowCount: Number(countResult.rows[0]?.c ?? 0),
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

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${quoted}`);
        if (rows.length > 0 && columns.length > 0) {
          const colList = columns.map(c => quoteIdentifier(c)).join(', ');
          for (const row of rows) {
            const values = columns.map(c => row[c] ?? null);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            await client.query(`INSERT INTO ${quoted} (${colList}) VALUES (${placeholders})`, values);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
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
  console.error(`AgentsGate PostgreSQL MCP Server running on stdio`);
  console.error(`Connection: ${redactConnectionString(connectionString)}`);
}

runServer().catch((error) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
